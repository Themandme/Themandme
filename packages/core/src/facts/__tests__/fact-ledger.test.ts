import { facts, seed, sources, type Db } from '@magnolia/db';
import { createTestDb, type TestDb } from '@magnolia/testkit';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getFactProvenance } from '../provenance.js';
import { loadPredicateRegistry, type PredicateRegistry } from '../predicate-registry.js';
import {
  currentFactsFor,
  EpistemicViolationError,
  recordFact,
  UnknownSourceError,
} from '../record-fact.js';

/**
 * Fact ledger. BUILD_PLAN M1.3/M1.4, spec §4.1.
 *
 * Seeds via the real `seed()` so these run against the same predicate registry and source
 * rows production gets — a hand-built fixture would drift from config/predicates/v1.yaml.
 */

let harness: TestDb | undefined;
let db: Db;
let registry: PredicateRegistry;
const sourceIds = new Map<string, string>();

/** Flatten an error and its causes into one searchable string. */
function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      const withConstraint = current as unknown as { constraint_name?: string };
      if (typeof withConstraint.constraint_name === 'string') {
        parts.push(withConstraint.constraint_name);
      }
      current = current.cause;
    } else {
      parts.push(JSON.stringify(current));
      break;
    }
  }
  return parts.join(' | ');
}

/** A property row to hang facts off. Facts reference subjects by id, not by FK. */
const PROPERTY_ID = '00000000-0000-7000-8000-000000000001';

async function sourceId(key: string): Promise<string> {
  const cached = sourceIds.get(key);
  if (cached !== undefined) return cached;
  const [row] = await db.select().from(sources).where(eq(sources.key, key)).limit(1);
  if (row === undefined) throw new Error(`test setup: no seeded source "${key}"`);
  sourceIds.set(key, row.id);
  return row.id;
}

beforeAll(async () => {
  harness = await createTestDb('fact_ledger');
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
  await db.delete(facts);
  sourceIds.clear();
});

describe('AT-1 — provenance', () => {
  it('resolves source, timestamp, confidence and epistemic level for a recorded fact', async () => {
    const observedAt = new Date('2026-03-01T12:00:00Z');
    const recorded = await recordFact(db, registry, {
      subjectType: 'property',
      subjectId: PROPERTY_ID,
      predicate: 'property.year_built',
      value: 1920,
      epistemic: 'fact',
      sourceId: await sourceId('md.sdat_parcel_points'),
      observedAt,
      confidence: 0.95,
    });

    const provenance = await getFactProvenance(db, recorded.id);
    expect(provenance).toBeDefined();
    expect(provenance?.source.key).toBe('md.sdat_parcel_points');
    expect(provenance?.source.tier).toBe('official_record');
    expect(provenance?.observedAt.toISOString()).toBe(observedAt.toISOString());
    expect(provenance?.confidence).toBe(0.95);
    expect(provenance?.epistemic).toBe('fact');
    expect(provenance?.value).toBe(1920);
  });

  it('leaves no fact orphaned — every stored fact joins to a source', async () => {
    await recordFact(db, registry, {
      subjectType: 'property',
      subjectId: PROPERTY_ID,
      predicate: 'vacancy.vbn_open',
      value: true,
      epistemic: 'fact',
      sourceId: await sourceId('baltimore.vbn'),
      observedAt: new Date('2026-03-02T00:00:00Z'),
      confidence: 0.9,
    });

    const stored = await db.select().from(facts);
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) {
      const provenance = await getFactProvenance(db, row.id);
      expect(provenance, `fact ${row.id} has no resolvable provenance`).toBeDefined();
      expect(provenance?.source.id).toBeTruthy();
    }
  });

  it('rejects a fact whose source does not exist', async () => {
    await expect(
      recordFact(db, registry, {
        subjectType: 'property',
        subjectId: PROPERTY_ID,
        predicate: 'property.year_built',
        value: 1920,
        epistemic: 'fact',
        sourceId: uuidv7(),
        observedAt: new Date(),
        confidence: 0.9,
      }),
    ).rejects.toBeInstanceOf(UnknownSourceError);
  });
});

describe('predicate validation (M1.4)', () => {
  it('throws on an unregistered predicate', async () => {
    await expect(
      recordFact(db, registry, {
        subjectType: 'property',
        subjectId: PROPERTY_ID,
        predicate: 'property.not_a_real_predicate',
        value: 1,
        epistemic: 'fact',
        sourceId: await sourceId('md.sdat_parcel_points'),
        observedAt: new Date(),
        confidence: 0.9,
      }),
    ).rejects.toThrow(/Unregistered predicate/);
  });

  it('throws on a value that fails the predicate schema', async () => {
    await expect(
      recordFact(db, registry, {
        subjectType: 'property',
        subjectId: PROPERTY_ID,
        predicate: 'property.year_built',
        value: 'nineteen twenty',
        epistemic: 'fact',
        sourceId: await sourceId('md.sdat_parcel_points'),
        observedAt: new Date(),
        confidence: 0.9,
      }),
    ).rejects.toThrow(/Value rejected by the schema/);
  });

  it('throws on a value outside the schema bounds', async () => {
    await expect(
      recordFact(db, registry, {
        subjectType: 'property',
        subjectId: PROPERTY_ID,
        predicate: 'property.year_built',
        value: 3000,
        epistemic: 'fact',
        sourceId: await sourceId('md.sdat_parcel_points'),
        observedAt: new Date(),
        confidence: 0.9,
      }),
    ).rejects.toThrow(/Value rejected by the schema/);
  });

  it('rejects a confidence outside [0,1]', async () => {
    await expect(
      recordFact(db, registry, {
        subjectType: 'property',
        subjectId: PROPERTY_ID,
        predicate: 'property.year_built',
        value: 1920,
        epistemic: 'fact',
        sourceId: await sourceId('md.sdat_parcel_points'),
        observedAt: new Date(),
        confidence: 1.5,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('epistemic rules (spec §4.1 rule 3, CLAUDE.md invariant 2)', () => {
  it('refuses epistemic=fact from an ai_inference source', async () => {
    await expect(
      recordFact(db, registry, {
        subjectType: 'property',
        subjectId: PROPERTY_ID,
        predicate: 'property.year_built',
        value: 1920,
        epistemic: 'fact',
        sourceId: await sourceId('magnolia.ai_inference'),
        observedAt: new Date(),
        confidence: 0.6,
      }),
    ).rejects.toBeInstanceOf(EpistemicViolationError);
  });

  it('refuses anything but inference from an ai_inference source', async () => {
    await expect(
      recordFact(db, registry, {
        subjectType: 'property',
        subjectId: PROPERTY_ID,
        predicate: 'property.year_built',
        value: 1920,
        epistemic: 'prediction',
        sourceId: await sourceId('magnolia.ai_inference'),
        observedAt: new Date(),
        confidence: 0.6,
      }),
    ).rejects.toBeInstanceOf(EpistemicViolationError);
  });

  it('accepts inference from an ai_inference source', async () => {
    const recorded = await recordFact(db, registry, {
      subjectType: 'property',
      subjectId: PROPERTY_ID,
      predicate: 'property.year_built',
      value: 1920,
      epistemic: 'inference',
      sourceId: await sourceId('magnolia.ai_inference'),
      observedAt: new Date(),
      confidence: 0.6,
    });
    expect(recorded.created).toBe(true);
  });

  it('refuses epistemic=fact from a secondary-tier source', async () => {
    /* baltimore.311 is a citizen report, not a finding of fact. §4.1 rule 3 confines 'fact'
       to official_record, commercial_data and human. */
    await expect(
      recordFact(db, registry, {
        subjectType: 'property',
        subjectId: PROPERTY_ID,
        predicate: 'vacancy.vbn_open',
        value: true,
        epistemic: 'fact',
        sourceId: await sourceId('baltimore.311'),
        observedAt: new Date(),
        confidence: 0.5,
      }),
    ).rejects.toBeInstanceOf(EpistemicViolationError);
  });

  it('accepts epistemic=fact from a human source', async () => {
    const recorded = await recordFact(db, registry, {
      subjectType: 'property',
      subjectId: PROPERTY_ID,
      predicate: 'property.year_built',
      value: 1920,
      epistemic: 'fact',
      sourceId: await sourceId('magnolia.human'),
      observedAt: new Date(),
      confidence: 1,
    });
    expect(recorded.created).toBe(true);
  });
});

describe('idempotency and superseding (invariant 7, spec §4.1 rule 5)', () => {
  const draft = async () => ({
    subjectType: 'property' as const,
    subjectId: PROPERTY_ID,
    predicate: 'property.year_built',
    value: 1920,
    epistemic: 'fact' as const,
    sourceId: await sourceId('md.sdat_parcel_points'),
    observedAt: new Date('2026-03-01T00:00:00Z'),
    confidence: 0.95,
  });

  it('writes nothing on an identical repeat', async () => {
    const first = await recordFact(db, registry, await draft());
    const second = await recordFact(db, registry, await draft());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await db.select().from(facts)).toHaveLength(1);
  });

  it('supersedes rather than mutating when the value changes', async () => {
    const first = await recordFact(db, registry, await draft());
    const second = await recordFact(db, registry, { ...(await draft()), value: 1925 });

    expect(second.created).toBe(true);
    expect(second.supersededFactId).toBe(first.id);

    const [old] = await db.select().from(facts).where(eq(facts.id, first.id));
    expect(old?.isCurrent).toBe(false);
    expect(old?.superseded).toBe(second.id);

    /* History is never deleted — both rows survive, one current. */
    expect(await db.select().from(facts)).toHaveLength(2);
    const current = await currentFactsFor(db, 'property', PROPERTY_ID, 'property.year_built');
    expect(current).toHaveLength(1);
    expect(current[0]?.value).toBe(1925);
  });

  it('allows two current facts on one predicate from DIFFERENT sources', async () => {
    /* This is what makes conflict detection possible at all (§4.1 rule 6): disagreement is
       between sources. The one-current-per-source index must not prevent it. */
    await recordFact(db, registry, await draft());
    await recordFact(db, registry, {
      ...(await draft()),
      value: 1931,
      sourceId: await sourceId('baltimore.real_property'),
    });

    const current = await currentFactsFor(db, 'property', PROPERTY_ID, 'property.year_built');
    expect(current).toHaveLength(2);
  });

  it('the database refuses a second current fact from the same source', async () => {
    /* Proves facts_one_current_per_source is real, not just respected by recordFact. */
    const base = await draft();
    await recordFact(db, registry, base);

    /* Drizzle wraps the driver error, so the constraint name lives on the cause, not the
       top-level message. Walk the chain rather than matching the wrapper text. */
    let thrown: unknown;
    try {
      await db.insert(facts).values({
        id: uuidv7(),
        subjectType: base.subjectType,
        subjectId: base.subjectId,
        predicate: base.predicate,
        value: 1999,
        epistemic: base.epistemic,
        sourceId: base.sourceId,
        observedAt: base.observedAt,
        confidence: 0.5,
        isCurrent: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown, 'a second current fact from one source must be rejected').toBeDefined();
    expect(errorChain(thrown)).toMatch(/facts_one_current_per_source/);
  });
});

describe('TTL derivation (spec §4.1 volatility classes)', () => {
  it('leaves expires_at null for a durable predicate', async () => {
    const recorded = await recordFact(db, registry, {
      subjectType: 'property',
      subjectId: PROPERTY_ID,
      predicate: 'property.year_built', // durable
      value: 1920,
      epistemic: 'fact',
      sourceId: await sourceId('md.sdat_parcel_points'),
      observedAt: new Date('2026-03-01T00:00:00Z'),
      confidence: 0.95,
    });
    const provenance = await getFactProvenance(db, recorded.id);
    expect(provenance?.expiresAt).toBeNull();
  });

  it('sets expires_at 30 days out for a volatile predicate', async () => {
    const observedAt = new Date('2026-03-01T00:00:00Z');
    const recorded = await recordFact(db, registry, {
      subjectType: 'property',
      subjectId: PROPERTY_ID,
      predicate: 'tax.on_sale_list', // volatile, 30d
      value: true,
      epistemic: 'fact',
      sourceId: await sourceId('baltimore.tax_sale'),
      observedAt,
      confidence: 0.95,
    });
    const provenance = await getFactProvenance(db, recorded.id);
    expect(provenance?.expiresAt?.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });
});

describe('seed idempotency (M1.2, invariant 7)', () => {
  it('re-running the seed changes nothing', async () => {
    const report = await seed(db);
    const written = Object.values(report).reduce((n, c) => n + c.inserted + c.updated, 0);
    expect(written).toBe(0);
  });

  it('seeds no enabled feature flag (invariant 8)', async () => {
    const enabled = await db.query.featureFlags.findMany({
      where: (f, { eq: e }) => e(f.enabled, true),
    });
    expect(enabled).toHaveLength(0);
  });

  it('keeps ToS-restricted sources manual-only (spec §4.5)', async () => {
    for (const key of ['md.case_search', 'md.land_records']) {
      const [row] = await db.select().from(sources).where(eq(sources.key, key)).limit(1);
      expect(row?.scrapingAllowed, `${key} must not allow scraping`).toBe(false);
      expect(row?.accessMethod, `${key} must be manual_upload`).toBe('manual_upload');
    }
  });

  it('has no source claiming both manual_upload and scraping', async () => {
    const bad = await db
      .select()
      .from(sources)
      .where(and(eq(sources.accessMethod, 'manual_upload'), eq(sources.scrapingAllowed, true)));
    expect(bad).toHaveLength(0);
  });
});
