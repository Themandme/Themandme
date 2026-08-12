import { loadEnv } from '@magnolia/config';
import { closeDb, createDb } from '@magnolia/db';
import { createIngestWorker } from './ingest/ingest-worker.js';
import { createProductionRegistry } from './ingest/registry.js';
import { createLogger } from './logger.js';
import { createPublisher } from './publisher.js';
import { createScheduler } from './scheduler.js';

/**
 * Worker entrypoint.
 *
 * Three long-running pieces in one process:
 *
 *   1. the **outbox publisher** — moves committed `events` rows onto BullMQ (M1.6);
 *   2. the **ingest scheduler** — classifies sources against their cron and enqueues (M2.1);
 *   3. the **ingest worker** — consumes that queue and actually fetches (M2).
 *
 * One process rather than three because they share a database pool and a Redis connection
 * budget, and because at this stage the operational cost of three deployables outweighs the
 * isolation. They are separate constructors, so splitting them later is a change to this file
 * only.
 *
 * Note what booting does NOT do: it does not enable anything. Every external source seeds
 * `enabled: false` with its kill switch off (invariant 8), so a freshly deployed worker sweeps,
 * finds everything refused, logs why, and fetches nothing. That is the intended day-one
 * behaviour, not a misconfiguration.
 */

function main(): void {
  /*
   * Environment first, before any connection is opened. `loadEnv` throws a ConfigurationError
   * listing every problem at once, and in local/staging it is also what refuses to start if
   * comms credentials are present (spec §3.2) — so a misconfigured deploy dies here rather than
   * after it has begun accepting work.
   */
  const env = loadEnv(process.env);
  const log = createLogger(env.LOG_LEVEL, { app: 'worker', env: env.MAGNOLIA_ENV });

  const db = createDb(env.DATABASE_URL);
  const registry = createProductionRegistry({ userAgent: env.OUTBOUND_USER_AGENT });

  const publisher = createPublisher(db, { redisUrl: env.REDIS_URL });
  const scheduler = createScheduler(db, {
    redisUrl: env.REDIS_URL,
    onSweep: (schedules) => {
      /* Debug, not info: this fires every sweep and would otherwise bury real events. The
         refused/due counts go out at info so the shape of a sweep is still visible. */
      const counts = schedules.reduce<Record<string, number>>((acc, schedule) => {
        acc[schedule.state.status] = (acc[schedule.state.status] ?? 0) + 1;
        return acc;
      }, {});
      log.debug('sweep', counts);
    },
  });
  const ingestWorker = createIngestWorker(db, {
    redisUrl: env.REDIS_URL,
    registry,
    logger: log,
  });

  log.info('worker starting', {
    adapters: registry.keys(),
    /* Says plainly that registration is not permission — the usual reason "nothing happened". */
    note: 'registered adapters still require an enabled source row and an on kill switch',
  });

  publisher.start();
  scheduler.start();

  /*
   * Graceful shutdown. Container orchestrators send SIGTERM and then SIGKILL after a grace
   * period, so the window is short and the ordering matters:
   *
   *   - the scheduler stops FIRST, so no new work is enqueued while we are draining;
   *   - the ingest worker closes next, which waits for in-flight jobs to finish rather than
   *     abandoning a half-written fetch;
   *   - the publisher and the pool go last.
   *
   * A job killed mid-run is not corrupting — the two-phase pipeline banks raw records before
   * normalizing, and both phases are idempotent — but finishing cleanly avoids re-fetching.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      log.warn('second signal — exiting immediately', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    log.info('shutting down', { signal });

    void (async () => {
      try {
        await scheduler.stop();
        await ingestWorker.close();
        await publisher.stop();
        await closeDb(db);
        log.info('shutdown complete');
        process.exit(0);
      } catch (error) {
        log.error('shutdown failed', { error });
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  /*
   * An unhandled rejection leaves the process in an unknown state. Exiting lets the orchestrator
   * restart it clean, which is strictly better than continuing to schedule fetches from a
   * process that has already failed in a way nobody handled.
   */
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection — exiting', { error: reason });
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception — exiting', { error });
    process.exit(1);
  });
}

try {
  main();
} catch (error: unknown) {
  /* Boot failure has no logger yet — `loadEnv` may be what threw, and LOG_LEVEL comes from it.
     Plain stderr and a non-zero exit is the whole contract with the orchestrator. */
  process.stderr.write(
    `worker failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}
