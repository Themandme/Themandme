import { factConflicts, facts, properties, seed, type Db } from '@magnolia/db';
import { createProperty, createTestDb, sourceIdByKey, type TestDb } from '@magnolia/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { detectConflicts, resolveConflict, valuesAgree } from '../conflicts.js';
import { loadPredicateRegistry, type PredicateRegistry } from '../predicate-registry.js';
import { recordFact } from '../record-fact.js';

/** Conflict detection and resolution. Spec §4.1 rule 6 and §4.2. */

let harness: TestDb;
let db: Db;
let registry: PredicateRegistry;
let propertyId: string;

/**
 * Epistemic level follows the source's tier rather than being hardcoded: spec §4.1 rule 3
 * restricts `fact` to official_record, commercial_data and human, and `recordFact` enforces
 * it. A secondary source such as baltimore.311 contributes an inference, not a fact.
 */
const TIER_BY_SOURCE: Record<string, 'fact' | 'inference'> = {
  'md.sdat_parcel_points': 'fact',
  'baltimore.real_property': 'fact',
  'magnolia.human': 'fact',
  'baltimore.311': 'inference',
};

async function record(
  predicate: string,
  value: unknown,
  sourceKey: string,
  observedAt = new Date('2026-01-01T00:00:00Z'),
): Promise<void> {
  await recordFact(db, registry, {
    subjectType: 'property',
    subjectId: propertyId,
    predicate,
    value,
    epistemic: TIER_BY_SOURCE[sourceKey] ?? 'inference',
    sourceId: await sourceIdByKey(db, sourceKey),
    observedAt,
    confidence: 0.9,
  });
}

beforeAll(async () => {
  harness = await createTestDb('conflicts');
  db = harness.db;
  await seed(db);
  registry = await loadPredicateRegistry(db);
}, 60_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(async () => {
  await db.delete(factConflicts);
  await db.delete(facts);
  await db.delete(properties);
  propertyId = await createProperty(db, 'conflict subject');
});

describe('tolerance', () => {
  it('treats numbers within tolerance as agreement', () => {
    expect(valuesAgree(1920, 1921, 1)).toBe(true);
    expect(valuesAgree(1920, 1923, 1)).toBe(false);
  });

  it('requires exact equality when no tolerance is set', () => {
    expect(valuesAgree('R-6', 'R-6', null)).toBe(true);
    expect(valuesAgree('R-6', 'R-8', null)).toBe(false);
  });

  it('compares objects structurally regardless of key order', () => {
    expect(valuesAgree({ a: 1, b: 2 }, { b: 2, a: 1 }, null)).toBe(true);
  });
});

describe('detection', () => {
  it('records no conflict when a single source holds the field', async () => {
    await record('property.assessed_value_cents', 10_000_00, 'md.sdat_parcel_points');
    const detected = await detectConflicts(
      db,
      registry,
      'property',
      propertyId,
      'property.assessed_value_cents',
    );
    expect(detected).toBeUndefined();
  });

  it('records no conflict when two sources agree within tolerance', async () => {
    /* property.year_built carries tolerance 1 — assessors and permit records routinely differ
       by a year, and calling that a conflict would bury the real ones in noise. */
    await record('property.year_built', 1920, 'md.sdat_parcel_points');
    await record('property.year_built', 1921, 'baltimore.real_property');

    const detected = await detectConflicts(
      db,
      registry,
      'property',
      propertyId,
      'property.year_built',
    );
    expect(detected).toBeUndefined();
  });

  it('writes a conflict row rather than silently picking when sources disagree', async () => {
    await record('property.assessed_value_cents', 10_000_00, 'md.sdat_parcel_points');
    await record('property.assessed_value_cents', 25_000_00, 'baltimore.real_property');

    const detected = await detectConflicts(
      db,
      registry,
      'property',
      propertyId,
      'property.assessed_value_cents',
    );
    expect(detected?.created).toBe(true);
    expect(detected?.factIds).toHaveLength(2);

    const rows = await db.select().from(factConflicts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolvedAt).toBeNull();
  });

  it('does not duplicate an already-open conflict', async () => {
    await record('property.assessed_value_cents', 10_000_00, 'md.sdat_parcel_points');
    await record('property.assessed_value_cents', 25_000_00, 'baltimore.real_property');

    const first = await detectConflicts(
      db,
      registry,
      'property',
      propertyId,
      'property.assessed_value_cents',
    );
    const second = await detectConflicts(
      db,
      registry,
      'property',
      propertyId,
      'property.assessed_value_cents',
    );

    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    expect(second?.conflictId).toBe(first?.conflictId);
    expect(await db.select().from(factConflicts)).toHaveLength(1);
  });
});

describe('resolution by the §4.2 hierarchy', () => {
  it('prefers the higher tier and records prefer_tier', async () => {
    await record('property.assessed_value_cents', 10_000_00, 'baltimore.311'); // secondary
    await record('property.assessed_value_cents', 25_000_00, 'md.sdat_parcel_points'); // official

    const detected = await detectConflicts(
      db,
      registry,
      'property',
      propertyId,
      'property.assessed_value_cents',
    );
    const outcome = await resolveConflict(db, registry, detected?.conflictId ?? '');

    expect(outcome.resolved).toBe(true);
    if (!outcome.resolved) return;
    expect(outcome.rule).toBe('prefer_tier');

    const [row] = await db
      .select()
      .from(factConflicts)
      .where(eq(factConflicts.id, detected!.conflictId));
    expect(row?.resolution).toBe('prefer_tier');
    expect(row?.resolvedFactId).toBe(outcome.factId);
    expect(row?.resolvedAt).not.toBeNull();
  });

  it('falls back to recency within a tier and records prefer_recent', async () => {
    /* Both official_record, so the tier does not separate them — recency does, and the
       resolver must say which rule decided it. "The higher tier won" and "they tied and this
       one was newer" are different claims about how much to trust the answer. */
    await record(
      'property.assessed_value_cents',
      10_000_00,
      'md.sdat_parcel_points',
      new Date('2026-01-01T00:00:00Z'),
    );
    await record(
      'property.assessed_value_cents',
      25_000_00,
      'baltimore.real_property',
      new Date('2026-06-01T00:00:00Z'),
    );

    const detected = await detectConflicts(
      db,
      registry,
      'property',
      propertyId,
      'property.assessed_value_cents',
    );
    const outcome = await resolveConflict(db, registry, detected?.conflictId ?? '');

    expect(outcome.resolved).toBe(true);
    if (!outcome.resolved) return;
    expect(outcome.rule).toBe('prefer_recent');
  });

  it('lets a human source outrank an official record', async () => {
    await record('property.assessed_value_cents', 10_000_00, 'md.sdat_parcel_points');
    await record('property.assessed_value_cents', 99_000_00, 'magnolia.human');

    const detected = await detectConflicts(
      db,
      registry,
      'property',
      propertyId,
      'property.assessed_value_cents',
    );
    const outcome = await resolveConflict(db, registry, detected?.conflictId ?? '');
    expect(outcome.resolved).toBe(true);
    if (!outcome.resolved) return;

    const [winner] = await db.select().from(facts).where(eq(facts.id, outcome.factId));
    expect(winner?.value).toBe(99_000_00);
  });

  it('refuses to auto-resolve an escalate-listed predicate', async () => {
    /* foreclosure.filed carries conflict_escalate. Auto-resolving a PHIFA-relevant
       disagreement by tier is exactly the silent pick rule 6 exists to prevent (§2.3). */
    await record('foreclosure.filed', true, 'md.sdat_parcel_points');
    await record('foreclosure.filed', false, 'baltimore.real_property');

    const detected = await detectConflicts(
      db,
      registry,
      'property',
      propertyId,
      'foreclosure.filed',
    );
    expect(detected?.created).toBe(true);

    const outcome = await resolveConflict(db, registry, detected?.conflictId ?? '');
    expect(outcome.resolved).toBe(false);
    if (outcome.resolved) return;
    expect(outcome.reason).toBe('escalated');

    const [row] = await db
      .select()
      .from(factConflicts)
      .where(eq(factConflicts.id, detected?.conflictId ?? ''));
    expect(row?.resolution).toBe('operator');
    expect(row?.resolvedAt, 'must stay open for a human').toBeNull();
  });

  it('does not resolve the same conflict twice', async () => {
    await record('property.assessed_value_cents', 10_000_00, 'baltimore.311');
    await record('property.assessed_value_cents', 25_000_00, 'md.sdat_parcel_points');

    const detected = await detectConflicts(
      db,
      registry,
      'property',
      propertyId,
      'property.assessed_value_cents',
    );
    await resolveConflict(db, registry, detected?.conflictId ?? '');
    const again = await resolveConflict(db, registry, detected?.conflictId ?? '');

    expect(again.resolved).toBe(false);
    if (again.resolved) return;
    expect(again.reason).toBe('already_resolved');
  });
});
