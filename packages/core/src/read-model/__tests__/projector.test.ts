import { facts, properties, seed, type Db } from '@magnolia/db';
import { createProperty, createTestDb, sourceIdByKey, type TestDb } from '@magnolia/testkit';
import { eq } from 'drizzle-orm';
import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadPredicateRegistry, type PredicateRegistry } from '../../facts/predicate-registry.js';
import { recordFact } from '../../facts/record-fact.js';
import { computeProjection, projectAll, projectProperty } from '../project-property.js';

/**
 * Read-model projector. BUILD_PLAN M1.5 and its Definition of Done:
 * "any sequence of fact writes leaves the read model equal to a from-scratch recomputation."
 */

let harness: TestDb;
let db: Db;
let registry: PredicateRegistry;

/** Predicates that project into a column, with a generator for each. */
interface ProjectingSpec {
  key: string;
  column: string;
  arb: fc.Arbitrary<unknown>;
}

const PROJECTING: readonly ProjectingSpec[] = [
  { key: 'property.year_built', column: 'year_built', arb: fc.integer({ min: 1700, max: 2030 }) },
  {
    key: 'property.building_sqft',
    column: 'building_sqft',
    arb: fc.integer({ min: 0, max: 20_000 }),
  },
  { key: 'property.is_vacant_land', column: 'is_vacant_land', arb: fc.boolean() },
  {
    key: 'property.zoning_code',
    column: 'zoning_code',
    arb: fc.constantFrom('R-6', 'R-8', 'C-1', 'I-2'),
  },
  {
    key: 'property.assessed_value_cents',
    column: 'assessed_value_cents',
    arb: fc.integer({ min: 0, max: 50_000_000 }),
  },
];

const SOURCE_KEYS = ['md.sdat_parcel_points', 'baltimore.real_property', 'magnolia.human'] as const;

beforeAll(async () => {
  harness = await createTestDb('projector');
  db = harness.db;
  await seed(db);
  registry = await loadPredicateRegistry(db);
}, 60_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(async () => {
  await db.delete(facts);
  await db.delete(properties);
});

/** Read the projected columns off the stored row. */
async function storedColumns(propertyId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select().from(properties).where(eq(properties.id, propertyId)).limit(1);
  if (row === undefined) throw new Error('property vanished');
  return {
    year_built: row.yearBuilt,
    building_sqft: row.buildingSqft,
    is_vacant_land: row.isVacantLand,
    zoning_code: row.zoningCode,
    assessed_value_cents: row.assessedValueCents,
    property_type: row.propertyType,
    lot_sqft: row.lotSqft,
    beds: row.beds,
    baths: row.baths,
    last_sale_date: row.lastSaleDate,
    last_sale_price_cents: row.lastSalePriceCents,
  };
}

describe('projection basics', () => {
  it('writes the current fact into its read-model column', async () => {
    const propertyId = await createProperty(db, '2831 Guilford Ave');
    await recordFact(db, registry, {
      subjectType: 'property',
      subjectId: propertyId,
      predicate: 'property.year_built',
      value: 1912,
      epistemic: 'fact',
      sourceId: await sourceIdByKey(db, 'md.sdat_parcel_points'),
      observedAt: new Date('2026-01-01T00:00:00Z'),
      confidence: 0.95,
    });

    await projectProperty(db, registry, propertyId);
    const stored = await storedColumns(propertyId);
    expect(stored['year_built']).toBe(1912);
  });

  it('is idempotent — projecting twice changes nothing', async () => {
    const propertyId = await createProperty(db, '1 Idempotent St');
    await recordFact(db, registry, {
      subjectType: 'property',
      subjectId: propertyId,
      predicate: 'property.zoning_code',
      value: 'R-6',
      epistemic: 'fact',
      sourceId: await sourceIdByKey(db, 'md.sdat_parcel_points'),
      observedAt: new Date('2026-01-01T00:00:00Z'),
      confidence: 0.9,
    });

    await projectProperty(db, registry, propertyId);
    const first = await storedColumns(propertyId);
    await projectProperty(db, registry, propertyId);
    expect(await storedColumns(propertyId)).toEqual(first);
  });

  it('clears a column back to null when the backing fact stops being current', async () => {
    /* The read model is derived, not accumulated. A stale value left behind after its fact
       went away is exactly the "address says vacant, read model says occupied" mystery
       invariant 1 exists to prevent. */
    const propertyId = await createProperty(db, '2 Retraction Rd');
    const sourceId = await sourceIdByKey(db, 'md.sdat_parcel_points');
    await recordFact(db, registry, {
      subjectType: 'property',
      subjectId: propertyId,
      predicate: 'property.year_built',
      value: 1912,
      epistemic: 'fact',
      sourceId,
      observedAt: new Date('2026-01-01T00:00:00Z'),
      confidence: 0.95,
    });
    await projectProperty(db, registry, propertyId);
    expect((await storedColumns(propertyId))['year_built']).toBe(1912);

    await db.update(facts).set({ isCurrent: false }).where(eq(facts.subjectId, propertyId));
    await projectProperty(db, registry, propertyId);
    expect((await storedColumns(propertyId))['year_built']).toBeNull();
  });

  it('prefers the higher-tier source when two disagree (spec §4.2)', async () => {
    const propertyId = await createProperty(db, '3 Hierarchy Way');
    const observedAt = new Date('2026-01-01T00:00:00Z');

    await recordFact(db, registry, {
      subjectType: 'property',
      subjectId: propertyId,
      predicate: 'property.year_built',
      value: 1900,
      epistemic: 'fact',
      sourceId: await sourceIdByKey(db, 'md.sdat_parcel_points'), // official_record
      observedAt,
      confidence: 0.9,
    });
    await recordFact(db, registry, {
      subjectType: 'property',
      subjectId: propertyId,
      predicate: 'property.year_built',
      value: 1955,
      epistemic: 'fact',
      sourceId: await sourceIdByKey(db, 'magnolia.human'), // human outranks everything
      observedAt,
      confidence: 1,
    });

    await projectProperty(db, registry, propertyId);
    expect((await storedColumns(propertyId))['year_built']).toBe(1955);
  });

  it('projectAll re-runs across every property', async () => {
    const a = await createProperty(db, '10 Alpha Ave');
    const b = await createProperty(db, '20 Beta Blvd');
    const sourceId = await sourceIdByKey(db, 'md.sdat_parcel_points');
    for (const [id, year] of [
      [a, 1901],
      [b, 1999],
    ] as const) {
      await recordFact(db, registry, {
        subjectType: 'property',
        subjectId: id,
        predicate: 'property.year_built',
        value: year,
        epistemic: 'fact',
        sourceId,
        observedAt: new Date('2026-01-01T00:00:00Z'),
        confidence: 0.9,
      });
    }

    const result = await projectAll(db, registry);
    expect(result.projected).toBe(2);
    expect((await storedColumns(a))['year_built']).toBe(1901);
    expect((await storedColumns(b))['year_built']).toBe(1999);
  });
});

describe('M1 DoD — read model equals a from-scratch recomputation', () => {
  /**
   * The property: for ANY sequence of fact writes, projecting after every single write leaves
   * the same row as projecting once at the end.
   *
   * That is what "equal to a from-scratch recomputation" has to mean here. Note the sequence
   * is applied in the SAME order to both properties — write order is meaningful, because
   * superseding makes the most recently *written* fact current for a given source (spec §4.1
   * rule 5), not the one with the latest observed_at. What the property pins down is that the
   * projector carries no state between runs: intermediate projections cannot influence the
   * final answer.
   */
  it('incremental projection matches a single projection at the end', async () => {
    const writeArb = fc.record({
      predicateIndex: fc.integer({ min: 0, max: PROJECTING.length - 1 }),
      sourceIndex: fc.integer({ min: 0, max: SOURCE_KEYS.length - 1 }),
      valueSeed: fc.integer({ min: 0, max: 1_000_000 }),
      dayOffset: fc.integer({ min: 0, max: 400 }),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(writeArb, { minLength: 1, maxLength: 12 }), async (writes) => {
        await db.delete(facts);
        await db.delete(properties);

        const incremental = await createProperty(db, 'incremental');
        const atEnd = await createProperty(db, 'at-end');

        for (const write of writes) {
          const predicate = PROJECTING[write.predicateIndex];
          const sourceKey = SOURCE_KEYS[write.sourceIndex];
          if (predicate === undefined || sourceKey === undefined) continue;

          const value = fc.sample(predicate.arb, { seed: write.valueSeed, numRuns: 1 })[0];
          const sourceId = await sourceIdByKey(db, sourceKey);
          const observedAt = new Date(Date.UTC(2026, 0, 1) + write.dayOffset * 86_400_000);

          for (const propertyId of [incremental, atEnd]) {
            await recordFact(db, registry, {
              subjectType: 'property',
              subjectId: propertyId,
              predicate: predicate.key,
              value,
              epistemic: 'fact',
              sourceId,
              observedAt,
              confidence: 0.9,
            });
          }

          /* Only the first property is projected as we go. */
          await projectProperty(db, registry, incremental);
        }

        await projectProperty(db, registry, atEnd);

        const incrementalRow = await storedColumns(incremental);
        const atEndRow = await storedColumns(atEnd);
        expect(incrementalRow).toEqual(atEndRow);
      }),
      { numRuns: 25 },
    );
  }, 120_000);

  it('the persisted row always equals the pure computation', async () => {
    /* Guards the other half: that writing the projection does not distort it — coercion
       through Postgres round-trips to the same values the computation produced. */
    const propertyId = await createProperty(db, '99 Purity Pl');
    const sourceId = await sourceIdByKey(db, 'md.sdat_parcel_points');

    for (const predicate of PROJECTING) {
      const value = fc.sample(predicate.arb, { seed: 7, numRuns: 1 })[0];
      await recordFact(db, registry, {
        subjectType: 'property',
        subjectId: propertyId,
        predicate: predicate.key,
        value,
        epistemic: 'fact',
        sourceId,
        observedAt: new Date('2026-02-02T00:00:00Z'),
        confidence: 0.9,
      });
    }

    const computed = await computeProjection(db, registry, propertyId);
    await projectProperty(db, registry, propertyId);
    const stored = await storedColumns(propertyId);

    for (const [column, value] of Object.entries(computed)) {
      expect(stored[column], `column ${column}`).toEqual(value);
    }
  });
});
