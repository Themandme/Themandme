import { classifySources, dueNow, formatSchedule, type SourceSchedule } from '@magnolia/core';
import type { Db } from '@magnolia/db';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/**
 * Ingestion scheduler. BUILD_PLAN M2.1.
 *
 * Same split as the outbox publisher: the decision — which sources are due, which are refused
 * and why — lives in `packages/core` (`classifySources`) where it is tested without Redis. This
 * file is only the wiring, which is why the queue client is here and not there. A ToS-restricted
 * source cannot become fetchable through a change to this file.
 *
 * The sweep enqueues; it does not fetch. `ingestSource` still calls
 * `registry.requireRunnable`, which re-checks the row, the kill switch and `scraping_allowed`
 * at execution time and **throws** if any of them says no. That re-check is not redundant: a
 * source can be disabled between the sweep that enqueued it and the worker that runs it, and a
 * kill switch that only takes effect at scheduling time is not a kill switch.
 */

export const INGEST_QUEUE_NAME = 'magnolia.ingest';

export interface SchedulerOptions {
  redisUrl: string;
  /** How often to re-classify. Cron granularity here is minutes, so a minute is plenty. */
  sweepIntervalMs?: number;
  /** Called with the full classification after each sweep, for the operator log. */
  onSweep?: (schedules: readonly SourceSchedule[]) => void;
}

export interface SweepOutcome {
  enqueued: string[];
  /** Every source and its state, so "refused" and "not due" stay distinguishable upstream. */
  schedules: SourceSchedule[];
}

export interface Scheduler {
  runOnce: () => Promise<SweepOutcome>;
  start: () => void;
  stop: () => Promise<void>;
}

/**
 * The job id for one source's scheduled run.
 *
 * Built from the source key and the window it is due for, so a sweep that runs every minute
 * enqueues **one** job per cron window rather than one per sweep. Without this, a daily source
 * that is due at 06:00 would be enqueued 1,440 times before its run updated `last_success_at`.
 * BullMQ deduplicates on job id, so this is invariant 7 applied to scheduling.
 */
export function ingestJobId(key: string, dueSince: Date): string {
  /* BullMQ rejects `:` in a custom job id — it is Redis's own key separator — so the window's
     colons are swapped for dashes. The timestamp is kept in ISO form rather than as epoch
     milliseconds so a job sitting in a queue dashboard says when it was due without decoding. */
  return `${key}@${dueSince.toISOString().replaceAll(':', '-')}`;
}

export function createScheduler(db: Db, options: SchedulerOptions): Scheduler {
  const connection = new IORedis(options.redisUrl, {
    /* BullMQ requires this; without it a blocked command throws on the first stall. */
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(INGEST_QUEUE_NAME, { connection });
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;

  let running = false;
  let timer: NodeJS.Timeout | undefined;

  const runOnce = async (): Promise<SweepOutcome> => {
    const schedules = await classifySources(db, new Date());
    const enqueued: string[] = [];

    for (const schedule of dueNow(schedules)) {
      /* Narrowing for the type system; `dueNow` already filtered to this variant. */
      if (schedule.state.status !== 'due') continue;
      await queue.add(
        'ingest',
        { sourceKey: schedule.key, sourceId: schedule.sourceId },
        {
          jobId: ingestJobId(schedule.key, schedule.state.dueSince),
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
      enqueued.push(schedule.key);
    }

    options.onSweep?.(schedules);
    return { enqueued, schedules };
  };

  const loop = (): void => {
    if (!running) return;
    void runOnce()
      .catch((error: unknown) => {
        process.stderr.write(
          `ingest scheduler sweep failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .finally(() => {
        if (running) timer = setTimeout(loop, sweepIntervalMs);
      });
  };

  return {
    runOnce,
    start: () => {
      if (running) return;
      running = true;
      loop();
    },
    stop: async () => {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      await queue.close();
      connection.disconnect();
    },
  };
}

export { formatSchedule };
