import { featureFlags, seed, sources, type Db } from '@magnolia/db';
import { createTestDb, type TestDb } from '@magnolia/testkit';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import IORedis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createScheduler, INGEST_QUEUE_NAME, ingestJobId, type Scheduler } from '../scheduler.js';

/**
 * Scheduler wiring. BUILD_PLAN M2.1.
 *
 * The scheduling *decision* is tested without Redis in
 * `packages/core/src/scheduling/__tests__/due-sources.test.ts`. What is left to prove here is
 * only what that test cannot touch: that a due source actually reaches the queue, and that a
 * refused one never does.
 *
 * Like the database-backed suites, this FAILS rather than skips when Redis is unreachable. A
 * skipped test and a passing one are indistinguishable in a CI summary, and this is the only
 * thing checking that a ToS-restricted source cannot be enqueued.
 */

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

let harness: TestDb | undefined;
let db: Db;
let scheduler: Scheduler | undefined;
let connection: IORedis | undefined;
let queue: Queue | undefined;

async function enable(key: string): Promise<void> {
  await db.update(sources).set({ enabled: true }).where(eq(sources.key, key));
  await db
    .update(featureFlags)
    .set({ enabled: true })
    .where(eq(featureFlags.key, `source.${key}`));
}

/* Accessors rather than `!`: if `beforeAll` failed, every test should say so plainly instead of
   dereferencing undefined halfway through an assertion. */
function q(): Queue {
  if (queue === undefined) throw new Error('queue not initialised — did beforeAll fail?');
  return queue;
}

function sched(): Scheduler {
  if (scheduler === undefined) throw new Error('scheduler not initialised — did beforeAll fail?');
  return scheduler;
}

async function allJobs() {
  return q().getJobs(['waiting', 'delayed', 'active', 'completed']);
}

async function queuedKeys(): Promise<string[]> {
  const jobs = await allJobs();
  return jobs.map((job) => (job.data as { sourceKey: string }).sourceKey);
}

beforeAll(async () => {
  harness = await createTestDb('scheduler');
  db = harness.db;
  await seed(db);

  connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue(INGEST_QUEUE_NAME, { connection });
  scheduler = createScheduler(db, { redisUrl: REDIS_URL });
}, 60_000);

afterAll(async () => {
  if (scheduler !== undefined) await scheduler.stop();
  if (queue !== undefined) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
  connection?.disconnect();
  if (harness !== undefined) await harness.drop();
});

beforeEach(async () => {
  await q().obliterate({ force: true });
  await seed(db);
  await db.update(sources).set({ enabled: false, lastSuccessAt: null });
  await db.update(featureFlags).set({ enabled: false });
});

describe('what reaches the queue', () => {
  it('enqueues nothing in the seeded posture', async () => {
    /* Invariant 8, end to end: a freshly seeded production database schedules no fetches at
       all until an operator deliberately turns a source on. */
    const outcome = await sched().runOnce();
    expect(outcome.enqueued).toEqual([]);
    expect(await queuedKeys()).toEqual([]);
  });

  it('enqueues a source once both the row and the kill switch are on', async () => {
    await enable('baltimore.vbn');
    const outcome = await sched().runOnce();
    expect(outcome.enqueued).toEqual(['baltimore.vbn']);
    expect(await queuedKeys()).toEqual(['baltimore.vbn']);
  });

  it('never enqueues a ToS-restricted source, however it is configured', async () => {
    /* Spec §4.5 / §17.6. Enabling the row and the flag is not enough and must not be — this is
       the constraint that outranks operator intent until counsel rules in writing. */
    await enable('md.case_search');
    await enable('md.land_records');
    const outcome = await sched().runOnce();
    expect(outcome.enqueued).toEqual([]);
    expect(await queuedKeys()).toEqual([]);
  });

  it('still reports refused sources in the sweep, rather than dropping them', async () => {
    /* "Refused" and "nothing due" must not look alike to an operator. The queue stays empty,
       but the classification explains why. */
    const outcome = await sched().runOnce();
    const caseSearch = outcome.schedules.find((s) => s.key === 'md.case_search');
    expect(caseSearch?.state).toEqual({ status: 'refused', reason: 'scraping_not_allowed' });
    expect(outcome.schedules).toHaveLength((await db.select().from(sources)).length);
  });
});

describe('idempotency (invariant 7)', () => {
  it('does not re-enqueue the same window on a second sweep', async () => {
    /* The sweep runs every minute; a daily source is due for the whole day until its run
       updates last_success_at. Without a window-derived job id that is 1,440 duplicate jobs. */
    await enable('baltimore.vbn');
    await sched().runOnce();
    await sched().runOnce();
    await sched().runOnce();

    expect(await queuedKeys()).toEqual(['baltimore.vbn']);
  });

  it('derives the job id from the source and its due window', () => {
    const due = new Date('2026-08-12T06:00:00Z');
    /* No colons: BullMQ rejects them in a custom job id, and it does so at `queue.add` time —
       which means the constraint is only visible once a source is actually enqueued, and every
       test that enqueued nothing passed happily without it. */
    const id = ingestJobId('baltimore.vbn', due);
    expect(id).toBe('baltimore.vbn@2026-08-12T06-00-00.000Z');
    expect(id).not.toContain(':');

    /* A different window is a different job — the next day's run must not be deduplicated
       against today's. */
    expect(ingestJobId('baltimore.vbn', new Date('2026-08-13T06:00:00Z'))).not.toBe(id);
  });

  it('enqueues again once the source becomes due for a NEW window', async () => {
    /*
     * `runOnce` reads the real clock, so both anchors are set well in the past — their following
     * windows (2020-01-02 and 2020-01-06) are then unambiguously due whatever "now" is. Anchors
     * near the present make this pass or fail depending on the time of day the suite runs, which
     * is how the first draft of this test failed: at 05:5x UTC the second window had not yet
     * arrived. Window arithmetic itself is covered deterministically, with an injected clock, in
     * packages/core/src/scheduling/__tests__/due-sources.test.ts.
     */
    await enable('baltimore.vbn');
    await db
      .update(sources)
      .set({ lastSuccessAt: new Date('2020-01-01T06:00:00Z') })
      .where(eq(sources.key, 'baltimore.vbn'));
    await sched().runOnce();

    /* A successful run moved the anchor forward; the next window is a different job id. */
    await db
      .update(sources)
      .set({ lastSuccessAt: new Date('2020-01-05T06:00:00Z') })
      .where(eq(sources.key, 'baltimore.vbn'));
    await sched().runOnce();

    expect(await allJobs()).toHaveLength(2);
  });
});
