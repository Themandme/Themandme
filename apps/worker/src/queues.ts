/**
 * Queue names and job options, in one place.
 *
 * The producer and the consumer must agree on the name exactly, and a duplicated string literal
 * across two files is the kind of thing that drifts silently: the scheduler would keep enqueueing
 * happily onto a queue nobody reads, and the symptom would be "ingestion stopped" with no error
 * anywhere.
 */

export const OUTBOX_QUEUE_NAME = 'magnolia.events';
export const INGEST_QUEUE_NAME = 'magnolia.ingest';

/**
 * Redis key prefix for every queue this process touches.
 *
 * Exists because a test run and a live worker sharing one Redis is not a hypothetical: the
 * scheduler suite calls `queue.obliterate({ force: true })` between tests, and when that ran
 * against the same namespace as a running worker it destroyed the lock on an in-flight
 * 237,260-record ingest ("could not renew lock"), killed the job mid-run, and then had its own
 * enqueued jobs eaten by the live worker — which made two correct tests fail for reasons that
 * had nothing to do with the code under test.
 *
 * The database-backed suites already avoid this by giving each test file its own scratch
 * database. This is the Redis equivalent, and it is opt-in through the environment so that CI,
 * a developer's machine and a live worker can share a Redis without colliding.
 *
 * A FUNCTION rather than a constant, deliberately. ESM hoists imports, so a test that sets
 * `MAGNOLIA_QUEUE_PREFIX` at the top of its own module body runs that assignment *after* this
 * module has already been evaluated — a module-scope constant would have captured the default
 * and the isolation would silently not happen. Reading at construction time cannot go wrong that
 * way.
 */
export function queuePrefix(): string {
  return process.env['MAGNOLIA_QUEUE_PREFIX'] ?? 'magnolia';
}

/**
 * Lock and stall settings for the ingest worker.
 *
 * A full-market ingest is a SINGLE job that runs for tens of minutes. BullMQ's default 30-second
 * lock, renewed every 15, treats any pause longer than that as a stalled worker and hands the
 * job to someone else — so an event-loop stall during a large normalize batch could silently
 * produce two workers fetching the same source at once.
 *
 * `lockDuration` is therefore raised well past any plausible pause, and `maxStalledCount: 0`
 * makes a genuine stall FAIL the job rather than quietly re-run it. Re-running is safe in the
 * sense that ingestion is idempotent (invariant 7), but it is an hour of duplicated work and an
 * hour of duplicated load on a municipal endpoint, which is not something to do by accident.
 */
export const INGEST_WORKER_LOCK = {
  lockDuration: 300_000,
  lockRenewTime: 60_000,
  maxStalledCount: 0,
};

/**
 * Retry policy for an ingest job.
 *
 * These are network fetches against municipal services that go down for minutes at a time, so a
 * failure is usually transient and worth retrying. The backoff is generous — 30s, 60s, 120s —
 * because retrying a rate-limited or briefly-down ArcGIS service faster does not help, and the
 * scheduler will re-enqueue the window anyway if all attempts are exhausted.
 *
 * Refusals (kill switch off, ToS-restricted) bypass this entirely; see `isPermanent` in
 * ingest-worker.ts. Retrying a refusal would be both pointless and, if a flag flipped for an
 * unrelated reason mid-backoff, wrong.
 */
export const INGEST_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};
