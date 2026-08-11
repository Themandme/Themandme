import { events, facts, properties, seed, type Db } from '@magnolia/db';
import { createProperty, createTestDb, sourceIdByKey, type TestDb } from '@magnolia/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadPredicateRegistry, type PredicateRegistry } from '../../facts/predicate-registry.js';
import { recordFact } from '../../facts/record-fact.js';
import { emitEvent, publishBatch, unpublishedCount, type OutboxEvent } from '../outbox.js';

/** Transactional outbox. BUILD_PLAN M1.6. */

let harness: TestDb | undefined;
let db: Db;
let registry: PredicateRegistry;

beforeAll(async () => {
  harness = await createTestDb('outbox');
  db = harness.db;
  await seed(db);
  registry = await loadPredicateRegistry(db);
}, 60_000);

afterAll(async () => {
  /* Guarded: when beforeAll fails (an unreachable database, say) `harness` is undefined, and
     an unguarded teardown buries the real error under a TypeError cascade. */
  if (harness !== undefined) await harness.drop();
});

beforeEach(async () => {
  await db.delete(events);
  await db.delete(facts);
  await db.delete(properties);
});

describe('emitEvent', () => {
  it('appends an event', async () => {
    const emitted = await emitEvent(db, {
      topic: 'fact.recorded',
      payload: { predicate: 'property.year_built' },
    });
    expect(emitted.created).toBe(true);
    expect(await unpublishedCount(db)).toBe(1);
  });

  it('is idempotent on the dedupe key (invariant 7)', async () => {
    const draft = { topic: 'fact.recorded', payload: { n: 1 }, dedupeKey: 'ingest:2026-03-01:1' };
    const first = await emitEvent(db, draft);
    const second = await emitEvent(db, draft);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await db.select().from(events)).toHaveLength(1);
  });

  it('allows many events with no dedupe key', async () => {
    /* events_dedupe is partial (WHERE dedupe_key IS NOT NULL), so un-keyed events must not
       collide with each other. */
    await emitEvent(db, { topic: 'a', payload: {} });
    await emitEvent(db, { topic: 'b', payload: {} });
    expect(await db.select().from(events)).toHaveLength(2);
  });
});

describe('transactional atomicity — the reason this table exists', () => {
  it('rolls the event back with the fact when the transaction fails', async () => {
    const propertyId = await createProperty(db, '1 Atomic Ave');
    const sourceId = await sourceIdByKey(db, 'md.sdat_parcel_points');

    await expect(
      db.transaction(async (tx) => {
        await recordFact(tx, registry, {
          subjectType: 'property',
          subjectId: propertyId,
          predicate: 'property.year_built',
          value: 1910,
          epistemic: 'fact',
          sourceId,
          observedAt: new Date('2026-01-01T00:00:00Z'),
          confidence: 0.9,
        });
        await emitEvent(tx, {
          topic: 'fact.recorded',
          payload: { propertyId },
          subjectType: 'property',
          subjectId: propertyId,
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    /* Neither survives. The alternative — an event announcing a fact that was rolled back —
       is what a queue-first design produces, and it is unrecoverable downstream. */
    expect(await db.select().from(facts)).toHaveLength(0);
    expect(await db.select().from(events)).toHaveLength(0);
  });

  it('commits the event with the fact when the transaction succeeds', async () => {
    const propertyId = await createProperty(db, '2 Atomic Ave');
    const sourceId = await sourceIdByKey(db, 'md.sdat_parcel_points');

    await db.transaction(async (tx) => {
      await recordFact(tx, registry, {
        subjectType: 'property',
        subjectId: propertyId,
        predicate: 'property.year_built',
        value: 1910,
        epistemic: 'fact',
        sourceId,
        observedAt: new Date('2026-01-01T00:00:00Z'),
        confidence: 0.9,
      });
      await emitEvent(tx, {
        topic: 'fact.recorded',
        payload: { propertyId },
        subjectType: 'property',
        subjectId: propertyId,
      });
    });

    expect(await db.select().from(facts)).toHaveLength(1);
    expect(await db.select().from(events)).toHaveLength(1);
  });
});

describe('publishBatch', () => {
  async function seedEvents(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await emitEvent(db, { topic: 'test.topic', payload: { i }, dedupeKey: `k${String(i)}` });
    }
  }

  it('publishes and marks claimed events', async () => {
    await seedEvents(3);
    const seen: OutboxEvent[] = [];

    const outcome = await db.transaction((tx) =>
      publishBatch(tx, async (event) => {
        seen.push(event);
        await Promise.resolve();
      }),
    );

    expect(outcome).toEqual({ claimed: 3, published: 3, failed: 0 });
    expect(seen).toHaveLength(3);
    expect(await unpublishedCount(db)).toBe(0);
  });

  it('does not republish an already-published event', async () => {
    await seedEvents(2);
    await db.transaction((tx) => publishBatch(tx, async () => Promise.resolve()));
    const second = await db.transaction((tx) => publishBatch(tx, async () => Promise.resolve()));
    expect(second.claimed).toBe(0);
  });

  it('leaves a failed event unpublished without poisoning its siblings', async () => {
    await seedEvents(3);

    const outcome = await db.transaction((tx) =>
      publishBatch(tx, async (event) => {
        if (event.dedupeKey === 'k1') throw new Error('provider down');
        await Promise.resolve();
      }),
    );

    expect(outcome.published).toBe(2);
    expect(outcome.failed).toBe(1);
    expect(await unpublishedCount(db)).toBe(1);

    const [stuck] = await db.select().from(events).where(eq(events.dedupeKey, 'k1'));
    expect(stuck?.publishedAt).toBeNull();
    expect(stuck?.attempts).toBe(1);
    expect(stuck?.lastError).toContain('provider down');
  });

  it('retries a previously failed event on the next sweep', async () => {
    await seedEvents(1);
    await db.transaction((tx) => publishBatch(tx, () => Promise.reject(new Error('transient'))));
    expect(await unpublishedCount(db)).toBe(1);

    const retry = await db.transaction((tx) => publishBatch(tx, () => Promise.resolve()));
    expect(retry.published).toBe(1);
    expect(await unpublishedCount(db)).toBe(0);

    const [row] = await db.select().from(events).where(eq(events.dedupeKey, 'k0'));
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBeNull();
  });

  it('respects the batch limit', async () => {
    await seedEvents(5);
    const outcome = await db.transaction((tx) => publishBatch(tx, () => Promise.resolve(), 2));
    expect(outcome.claimed).toBe(2);
    expect(await unpublishedCount(db)).toBe(3);
  });
});
