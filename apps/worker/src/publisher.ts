import { publishBatch, type OutboxEvent, type PublishOutcome } from '@magnolia/core';
import type { Db } from '@magnolia/db';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/**
 * Outbox publisher. BUILD_PLAN M1.6.
 *
 * Moves committed `events` rows onto BullMQ. The claim-and-mark logic lives in
 * `packages/core` (`publishBatch`) so it is testable without Redis; this file is only the
 * wiring, which is why the queue client lives here and not there.
 *
 * Each sweep runs in one transaction: rows are claimed with FOR UPDATE SKIP LOCKED and the
 * locks are held until commit, so several publisher instances can run at once without
 * double-publishing.
 */

export const OUTBOX_QUEUE_NAME = 'magnolia.events';

export interface PublisherOptions {
  redisUrl: string;
  /** Rows claimed per sweep. */
  batchSize?: number;
  /** Delay between sweeps when the last one found nothing. */
  idleDelayMs?: number;
}

export interface Publisher {
  runOnce: () => Promise<PublishOutcome>;
  start: () => void;
  stop: () => Promise<void>;
}

export function createPublisher(db: Db, options: PublisherOptions): Publisher {
  const connection = new IORedis(options.redisUrl, {
    /* BullMQ requires this; without it a blocked command throws on the first stall. */
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(OUTBOX_QUEUE_NAME, { connection });

  const batchSize = options.batchSize ?? 100;
  const idleDelayMs = options.idleDelayMs ?? 1000;

  let running = false;
  let timer: NodeJS.Timeout | undefined;

  const publish = async (event: OutboxEvent): Promise<void> => {
    await queue.add(
      event.topic,
      {
        eventId: event.id,
        topic: event.topic,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        payload: event.payload,
      },
      {
        /* The event id doubles as the job id, so a publish retried after an ambiguous failure
           cannot enqueue the same work twice (invariant 7). */
        jobId: event.id,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
  };

  const runOnce = async (): Promise<PublishOutcome> =>
    db.transaction((tx) => publishBatch(tx, publish, batchSize));

  const loop = (): void => {
    if (!running) return;
    void runOnce()
      .then((outcome) => {
        /* Drain greedily while there is work, then back off. */
        const delay = outcome.claimed === batchSize ? 0 : idleDelayMs;
        timer = setTimeout(loop, delay);
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `outbox publisher sweep failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        timer = setTimeout(loop, idleDelayMs);
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
