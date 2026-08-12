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
