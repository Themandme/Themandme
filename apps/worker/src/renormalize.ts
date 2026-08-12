import { loadEnv } from '@magnolia/config';
import { closeDb, createDb, rawRecords, sources } from '@magnolia/db';
import { eq, sql } from 'drizzle-orm';
import { createLogger } from './logger.js';

/**
 * Re-derive facts from already-banked raw records, without re-fetching.
 *
 * `pnpm ingest:renormalize <source-key>`
 *
 * ## Why this is a separate thing from `ingest:resume`
 *
 * `resume` finishes work that was never done — it picks up records where `normalized_at` is
 * null. This handles the other case: work that WAS done, by a normalizer that has since been
 * fixed. Those records are marked complete, so `resume` correctly skips them and the fix stays
 * inert against everything already loaded.
 *
 * That case is not hypothetical. It is how the leading-zero house-number fix reached the loaded
 * Baltimore market: SDAT's owner block zero-pads ("0002 S COLLINGTON AVE") while the parcel's
 * own address components do not, and 8,060 properties carried a false `owner.absentee` because
 * of it. Fixing `normalizeAddress` fixed nothing already in the ledger.
 *
 * ## Why it is safe
 *
 * Only `normalized_at` is cleared. **Raw records are never touched and facts are never deleted**
 * — the ledger is append-only (invariant 1), so a corrected value arrives by superseding the old
 * one, and the old fact stays readable for replay. What changed and when is preserved rather
 * than rewritten, which is the difference between a correction and a cover-up.
 *
 * Re-normalizing is otherwise the same idempotent path as a first load (invariant 7):
 * `recordFacts` short-circuits an identical write, so predicates the fix did not touch cost a
 * comparison and produce no new rows.
 *
 * It deliberately does not re-fetch. Re-fetching would conflate two questions — "has the source
 * changed?" and "has our reading of it changed?" — and only the second one is being asked here.
 */

async function main(): Promise<void> {
  const sourceKey = process.argv[2];
  if (sourceKey === undefined) {
    process.stderr.write('usage: pnpm ingest:renormalize <source-key>\n');
    process.exit(2);
  }

  const env = loadEnv(process.env);
  const log = createLogger(env.LOG_LEVEL, { app: 'renormalize', source: sourceKey });
  const db = createDb(env.DATABASE_URL);

  const [source] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.key, sourceKey))
    .limit(1);
  if (source === undefined) {
    log.error('source not seeded');
    await closeDb(db);
    process.exit(1);
  }

  const [before] = await db
    .select({ n: sql<string>`count(*)::text` })
    .from(rawRecords)
    .where(eq(rawRecords.sourceId, source.id));
  const total = Number(before?.n ?? '0');
  if (total === 0) {
    log.info('nothing banked for this source — fetch it first');
    await closeDb(db);
    return;
  }

  /* `normalize_error` is cleared alongside it: a record that failed under the old normalizer
     should be judged by the new one, not carry the old verdict into the report. */
  await db
    .update(rawRecords)
    .set({ normalizedAt: null, normalizeError: null })
    .where(eq(rawRecords.sourceId, source.id));

  log.info('marked for re-normalization — now run ingest:resume', {
    records: total,
    next: `pnpm ingest:resume ${sourceKey}`,
  });
  await closeDb(db);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `renormalize failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
