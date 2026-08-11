import { events } from '@magnolia/db';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { DbOrTx, SubjectType } from '../facts/record-fact.js';

/**
 * Transactional outbox. BUILD_PLAN M1.6.
 *
 * `emitEvent` writes to `events` inside the CALLER'S transaction. That is the whole point: the
 * event and the state change it describes commit together or not at all, so "the fact was
 * written but the signal engine never heard about it" cannot happen. A publisher worker then
 * moves committed rows onto the queue.
 *
 * The queue client deliberately lives in apps/worker, not here — `publishBatch` takes the
 * publish function, so the outbox is testable without Redis and packages/core stays free of a
 * vendor SDK.
 */

export interface EventDraft {
  topic: string;
  payload: Record<string, unknown>;
  subjectType?: SubjectType;
  subjectId?: string;
  /**
   * Idempotency key (invariant 7). A re-run that emits the same key inserts nothing, so a
   * replayed ingestion cannot fan out into duplicate downstream jobs.
   */
  dedupeKey?: string;
}

export interface EmittedEvent {
  id: string | null;
  /** false when a row with this dedupe key already existed. */
  created: boolean;
}

/**
 * Append an event to the outbox.
 *
 * MUST be called with the same transaction as the state change it describes. Passing a bare
 * `Db` will still work, but the atomicity guarantee is then only as good as the caller's own
 * transaction boundary.
 */
export async function emitEvent(tx: DbOrTx, draft: EventDraft): Promise<EmittedEvent> {
  const id = uuidv7();

  const inserted = await tx
    .insert(events)
    .values({
      id,
      topic: draft.topic,
      subjectType: draft.subjectType ?? null,
      subjectId: draft.subjectId ?? null,
      payload: draft.payload,
      dedupeKey: draft.dedupeKey ?? null,
    })
    /* Bare DO NOTHING rather than a targeted clause: `events_dedupe` is a partial unique index
       (WHERE dedupe_key IS NOT NULL), and an untargeted conflict clause covers it without
       having to restate the predicate here and keep the two in sync. */
    .onConflictDoNothing()
    .returning({ id: events.id });

  const row = inserted[0];
  return row === undefined ? { id: null, created: false } : { id: row.id, created: true };
}

export interface OutboxEvent extends Record<string, unknown> {
  id: string;
  topic: string;
  subjectType: string | null;
  subjectId: string | null;
  payload: unknown;
  dedupeKey: string | null;
  attempts: number;
}

export interface PublishOutcome {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Claim a batch of unpublished events, hand each to `publish`, and mark the successes.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED` so several publisher instances can run concurrently
 * without either double-publishing or blocking on each other.
 *
 * A publish failure does not poison the batch: that event's `attempts` and `last_error` are
 * recorded and it stays unpublished for the next sweep, while its siblings still go out.
 */
export async function publishBatch(
  tx: DbOrTx,
  publish: (event: OutboxEvent) => Promise<void>,
  limit = 100,
): Promise<PublishOutcome> {
  const claimed = await tx.execute<OutboxEvent>(sql`
    SELECT id, topic, subject_type AS "subjectType", subject_id AS "subjectId",
           payload, dedupe_key AS "dedupeKey", attempts
    FROM ${events}
    WHERE published_at IS NULL
    ORDER BY created_at
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `);

  const rows = [...claimed];
  let published = 0;
  let failed = 0;

  for (const event of rows) {
    try {
      await publish(event);
      await tx.execute(
        sql`UPDATE ${events} SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = ${event.id}`,
      );
      published += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await tx.execute(
        sql`UPDATE ${events} SET attempts = attempts + 1, last_error = ${message} WHERE id = ${event.id}`,
      );
      failed += 1;
    }
  }

  return { claimed: rows.length, published, failed };
}

/** Count of events still waiting to be published. Feeds the queue-depth health check. */
export async function unpublishedCount(tx: DbOrTx): Promise<number> {
  const rows = await tx.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM ${events} WHERE published_at IS NULL`,
  );
  return Number(rows[0]?.count ?? '0');
}
