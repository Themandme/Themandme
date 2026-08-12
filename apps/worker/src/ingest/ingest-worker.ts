import type { Db } from '@magnolia/db';
import { SourceDisabledError, SourceNotRegisteredError } from '@magnolia/providers';
import type { AdapterRegistry } from '@magnolia/providers';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import type { Logger } from '../logger.js';
import { INGEST_QUEUE_NAME } from '../queues.js';
import { ingestSource, type IngestReport } from './run-ingest.js';

/**
 * The consumer for the queue `createScheduler` fills.
 *
 * Without this the loop is open: M2.1 gave us a producer, jobs accumulated, and nothing ever
 * fetched anything. This closes it.
 *
 * The job payload carries only the source key. Everything that decides whether the fetch may
 * happen is re-read from the database here, via `registry.requireRunnable` inside
 * `ingestSource` — deliberately, because a source can be disabled between the sweep that
 * enqueued it and the moment this runs. A kill switch that is only consulted at scheduling time
 * is not a kill switch.
 */

export interface IngestJobData {
  sourceKey: string;
  sourceId: string;
}

export interface IngestWorkerOptions {
  redisUrl: string;
  registry: AdapterRegistry;
  logger: Logger;
  /**
   * How many sources may be fetched at once. Default 2.
   *
   * Low on purpose. These are small municipal ArcGIS services, and the adapters already
   * rate-limit themselves per layer; the failure mode of too much concurrency here is getting
   * Magnolia blocked by Baltimore City, which is not recoverable by a retry.
   */
  concurrency?: number;
  /** Called after each successful run — the hook the M2 DoD record-count report hangs off. */
  onReport?: (report: IngestReport) => void;
}

/**
 * A refusal is a permanent condition, not a transient failure.
 *
 * `SourceDisabledError` means a kill switch is off or the source is ToS-restricted; retrying
 * that with backoff would hammer the queue and, worse, would eventually succeed if someone
 * flipped a flag for an unrelated reason. `SourceNotRegisteredError` is a deployment mismatch.
 * Neither is fixed by waiting, so both fail the job immediately and loudly.
 */
function isPermanent(error: unknown): boolean {
  return error instanceof SourceDisabledError || error instanceof SourceNotRegisteredError;
}

export function createIngestWorker(db: Db, options: IngestWorkerOptions): Worker<IngestJobData> {
  const connection = new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
  const log = options.logger.child({ component: 'ingest-worker' });

  const worker = new Worker<IngestJobData>(
    INGEST_QUEUE_NAME,
    async (job: Job<IngestJobData>) => {
      const { sourceKey } = job.data;
      const started = Date.now();
      log.info('ingest starting', { sourceKey, jobId: job.id });

      try {
        const report = await ingestSource(db, options.registry, sourceKey);
        log.info('ingest finished', {
          sourceKey,
          ms: Date.now() - started,
          fetched: report.fetched,
          banked: report.banked,
          normalized: report.normalized,
          facts: report.factsWritten,
          propertiesCreated: report.propertiesCreated,
          propertiesMatched: report.propertiesMatched,
          errors: report.errors.length,
        });

        /* Per-record normalize failures do not fail the job: the records stay pending with the
           reason recorded and the next run finishes them. Surfacing the count is what stops that
           from being silent. */
        if (report.errors.length > 0) {
          log.warn('ingest completed with per-record errors', {
            sourceKey,
            count: report.errors.length,
            first: report.errors[0]?.message,
          });
        }

        options.onReport?.(report);
        return report;
      } catch (error) {
        if (isPermanent(error)) {
          const reason = error instanceof SourceDisabledError ? error.reason : 'not_registered';
          log.error('ingest refused — not retrying', { sourceKey, reason, error });
          /* `UnrecoverableError` is the BullMQ signal for "do not burn the remaining attempts".
             It takes only a message, so the reason is folded into that message: the failure
             record in the queue then still says WHY it was refused, rather than turning a ToS
             refusal and a missing adapter into the same opaque entry. */
          throw new UnrecoverableError(
            `${error instanceof Error ? error.message : String(error)} [reason=${reason}]`,
          );
        }
        throw error;
      }
    },
    {
      connection,
      concurrency: options.concurrency ?? 2,
    },
  );

  worker.on('failed', (job, error) => {
    log.error('ingest job failed', {
      sourceKey: job?.data.sourceKey,
      jobId: job?.id,
      attempts: job?.attemptsMade,
      error,
    });
  });

  /* A worker-level error is a Redis or BullMQ problem, not a job problem — it has no job to
     attach to and would otherwise be an unhandled rejection that takes the process down. */
  worker.on('error', (error) => {
    log.error('ingest worker error', { error });
  });

  return worker;
}
