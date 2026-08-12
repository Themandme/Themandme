import { loadEnv } from '@magnolia/config';
import { loadPredicateRegistry, loadResolutionParams } from '@magnolia/core';
import { closeDb, createDb, rawRecords, sources, type Db } from '@magnolia/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createProductionRegistry } from './ingest/registry.js';
import { normalizePending } from './ingest/run-ingest.js';
import { createLogger } from './logger.js';

/**
 * Finish a partially-normalized load, without re-fetching.
 *
 * `pnpm ingest:resume <source-key>`
 *
 * The two-phase pipeline banks raw payloads before normalizing them, which makes a load
 * resumable in principle — but the only thing that *acts* on that is `ingestSource`, and that
 * re-runs the fetch first. For a source like SDAT that is eight minutes of paging a state
 * endpoint to re-learn what is already banked. This runs phase two alone.
 *
 * ## It retries, because the interesting failures are transient
 *
 * A full-market load takes tens of minutes, and over that window a database restart is a normal
 * event rather than an exceptional one — it happened three times while loading SDAT here. Each
 * time the work already committed survived and the process died. Retrying turns that from
 * "someone has to notice and restart it" into a pause.
 *
 * The retry is safe precisely because the pipeline is idempotent (invariant 7): a record already
 * marked `normalized_at` is not in the pending set, and `recordFact` short-circuits an identical
 * write. Resuming can only ever do the work that was not done.
 *
 * It does NOT retry forever. A run that stops making progress across consecutive attempts is
 * failing for a reason retrying will not fix, and it exits non-zero so a supervisor or an
 * operator sees it rather than watching a loop spin.
 */

const MAX_ATTEMPTS = 20;
const BACKOFF_MS = 5_000;

async function pendingCount(db: Db, sourceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)::text` })
    .from(rawRecords)
    .where(and(eq(rawRecords.sourceId, sourceId), isNull(rawRecords.normalizedAt)));
  return Number(row?.n ?? '0');
}

async function main(): Promise<void> {
  const sourceKey = process.argv[2];
  if (sourceKey === undefined) {
    process.stderr.write('usage: pnpm ingest:resume <source-key>\n');
    process.exit(2);
  }

  const env = loadEnv(process.env);
  const log = createLogger(env.LOG_LEVEL, { app: 'resume', source: sourceKey });
  const adapters = createProductionRegistry({ userAgent: env.OUTBOUND_USER_AGENT });

  const adapter = adapters.get(sourceKey);
  if (adapter === undefined) {
    log.error('no adapter registered', { known: adapters.keys() });
    process.exit(1);
  }

  let lastPending = Number.POSITIVE_INFINITY;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    /* A fresh pool per attempt: after a database restart the old one's sockets are dead, and
       reusing it just reproduces the failure that ended the previous attempt. */
    const db = createDb(env.DATABASE_URL);
    try {
      const [source] = await db
        .select({ id: sources.id, marketId: sources.marketId })
        .from(sources)
        .where(eq(sources.key, sourceKey))
        .limit(1);
      if (source?.marketId == null) {
        log.error('source not seeded, or has no market');
        process.exit(1);
      }

      const remaining = await pendingCount(db, source.id);
      if (remaining === 0) {
        log.info('nothing pending — load is complete');
        await closeDb(db);
        return;
      }

      /*
       * Progress, not success, is the retry condition. A load that keeps failing but keeps
       * finishing records is worth continuing; one that fails without moving is stuck, and
       * hammering it wastes time and hides the real error.
       */
      if (remaining >= lastPending) {
        log.error('no progress since the last attempt — stopping', { remaining, attempt });
        await closeDb(db);
        process.exit(1);
      }
      lastPending = remaining;

      log.info('resuming', { remaining, attempt });
      const registry = await loadPredicateRegistry(db);
      const resolution = await loadResolutionParams(db, source.marketId);
      const started = Date.now();

      const report = await normalizePending(
        db,
        adapter,
        source.id,
        registry,
        source.marketId,
        resolution,
      );

      const ms = Date.now() - started;
      log.info('resume pass finished', {
        normalized: report.normalized,
        facts: report.factsWritten,
        propertiesCreated: report.propertiesCreated,
        errors: report.errors.length,
        chunkFallbacks: report.chunkFallbacks.length,
        perMinute: ms > 0 ? Math.round((report.normalized / ms) * 60_000) : 0,
      });

      if (report.chunkFallbacks.length > 0) {
        log.warn('batched path fell back', { first: report.chunkFallbacks[0]?.message });
      }

      const left = await pendingCount(db, source.id);
      await closeDb(db);
      if (left === 0) {
        log.info('load complete');
        return;
      }
      /* Records that failed validation stay pending by design; if only those are left, the
         previous pass made no progress on them and the next iteration will stop. */
      log.info('still pending after pass', { left });
    } catch (error) {
      log.warn('attempt failed — retrying', { attempt, error });
      await closeDb(db).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
    }
  }

  process.stderr.write(`gave up after ${String(MAX_ATTEMPTS)} attempts\n`);
  process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `resume failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
