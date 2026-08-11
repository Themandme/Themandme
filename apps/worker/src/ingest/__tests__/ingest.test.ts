import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { facts, featureFlags, properties, rawRecords, seed, sources, type Db } from '@magnolia/db';
import {
  createAdapterRegistry,
  normalizeSdatParcelPoint,
  normalizeVacantBuildingNotice,
  SourceDisabledError,
  SourceNotRegisteredError,
} from '@magnolia/providers';
import { createFixtureAdapter, createTestDb, type TestDb } from '@magnolia/testkit';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestSource } from '../run-ingest.js';

/**
 * Ingestion pipeline: the registry guard, AT-2, and resumability.
 *
 * Runs the REAL adapters' `normalize` against the REAL captured fixtures, with only the network
 * replaced. That keeps the test independent of a Baltimore endpoint being up while still
 * exercising the whole path: fetch, dedupe, normalize, resolve, record, project.
 */

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/providers/fixtures',
);

let harness: TestDb | undefined;
let db: Db;

function registry() {
  return createAdapterRegistry([
    createFixtureAdapter({
      key: 'md.sdat_parcel_points',
      fixtureDir: path.join(fixturesRoot, 'md.sdat_parcel_points'),
      normalize: normalizeSdatParcelPoint,
    }),
    createFixtureAdapter({
      key: 'baltimore.vbn',
      fixtureDir: path.join(fixturesRoot, 'baltimore.vbn'),
      normalize: normalizeVacantBuildingNotice,
    }),
  ]);
}

/** Turn a source on the way an operator would: the DB row and the kill switch, both. */
async function enableSource(key: string): Promise<void> {
  await db.update(sources).set({ enabled: true }).where(eq(sources.key, key));
  await db
    .update(featureFlags)
    .set({ enabled: true })
    .where(eq(featureFlags.key, `source.${key}`));
}

beforeAll(async () => {
  harness = await createTestDb('ingest');
  db = harness.db;
  await seed(db);
}, 60_000);

afterAll(async () => {
  if (harness !== undefined) await harness.drop();
});

beforeEach(async () => {
  await db.delete(facts);
  await db.delete(rawRecords);
  await db.execute(sql`DELETE FROM source_fetches`);
  await db.delete(properties);
  /* Back to the seeded posture: everything off. */
  await db.update(sources).set({ enabled: false });
  await db.update(featureFlags).set({ enabled: false });
});

describe('registry guard — refusing to run is the default', () => {
  it('throws for an unregistered adapter', async () => {
    await expect(ingestSource(db, registry(), 'baltimore.tax_sale')).rejects.toBeInstanceOf(
      SourceNotRegisteredError,
    );
  });

  it('refuses a source that is seeded disabled', async () => {
    /* Invariant 8: every external source seeds off. Running one is a deliberate act, and a
       disabled source must ERROR rather than quietly return an empty report — "refused" and
       "found nothing" must not look the same to a caller. */
    await expect(ingestSource(db, registry(), 'baltimore.vbn')).rejects.toBeInstanceOf(
      SourceDisabledError,
    );
  });

  it('refuses a ToS-restricted source even when enabled', async () => {
    /* md.case_search is seeded scraping_allowed=false (spec §4.5 MUST). Enabling the row must
       NOT be enough — the legal constraint outranks the operational one. */
    await db.update(sources).set({ enabled: true }).where(eq(sources.key, 'md.case_search'));
    const reg = registry();
    reg.register({
      ...createFixtureAdapter({
        key: 'md.case_search',
        fixtureDir: path.join(fixturesRoot, 'baltimore.vbn'),
        normalize: normalizeVacantBuildingNotice,
      }),
    });

    const error = await ingestSource(db, reg, 'md.case_search').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceDisabledError);
    expect((error as SourceDisabledError).reason).toBe('scraping_not_allowed');
  });

  it('refuses when the source row is on but the kill switch is off', async () => {
    await db.update(sources).set({ enabled: true }).where(eq(sources.key, 'baltimore.vbn'));
    const error = await ingestSource(db, registry(), 'baltimore.vbn').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceDisabledError);
    expect((error as SourceDisabledError).reason).toBe('flag_off');
  });

  it('runs once both the row and the flag are on', async () => {
    await enableSource('baltimore.vbn');
    const report = await ingestSource(db, registry(), 'baltimore.vbn');
    expect(report.fetched).toBe(5);
    expect(report.banked).toBe(5);
    expect(report.normalized).toBe(5);
    expect(report.errors).toEqual([]);
  });
});

describe('AT-2 — idempotent ingestion', () => {
  async function counts(): Promise<{ properties: number; facts: number; raw: number }> {
    return {
      properties: (await db.select().from(properties)).length,
      facts: (await db.select().from(facts)).length,
      raw: (await db.select().from(rawRecords)).length,
    };
  }

  it('running the full ingest twice changes nothing', async () => {
    await enableSource('md.sdat_parcel_points');
    await enableSource('baltimore.vbn');
    const reg = registry();

    const firstRun = [
      await ingestSource(db, reg, 'md.sdat_parcel_points'),
      await ingestSource(db, reg, 'baltimore.vbn'),
    ];
    const after1 = await counts();

    const secondRun = [
      await ingestSource(db, reg, 'md.sdat_parcel_points'),
      await ingestSource(db, reg, 'baltimore.vbn'),
    ];
    const after2 = await counts();

    expect(after2, 'AT-2: counts must be identical after a second identical run').toEqual(after1);

    /* The second run still FETCHES (the adapter has no cursor yet) but banks nothing new, and
       therefore normalizes nothing — raw_records_dedupe is the mechanism. */
    expect(firstRun.every((r) => r.banked > 0)).toBe(true);
    expect(secondRun.every((r) => r.banked === 0)).toBe(true);
    expect(secondRun.every((r) => r.normalized === 0)).toBe(true);
    expect(secondRun.every((r) => r.factsWritten === 0)).toBe(true);
  });

  it('creates no duplicate current facts', async () => {
    await enableSource('md.sdat_parcel_points');
    const reg = registry();
    await ingestSource(db, reg, 'md.sdat_parcel_points');
    await ingestSource(db, reg, 'md.sdat_parcel_points');

    const dupes = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM (
        SELECT subject_type, subject_id, predicate, source_id
        FROM ${facts} WHERE is_current
        GROUP BY 1,2,3,4 HAVING count(*) > 1
      ) d
    `);
    expect(Number(dupes[0]?.n ?? '0')).toBe(0);
  });

  it('projects the read model from the ingested facts', async () => {
    await enableSource('md.sdat_parcel_points');
    await ingestSource(db, registry(), 'md.sdat_parcel_points');

    const rows = await db.select().from(properties);
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.some((r) => r.yearBuilt !== null && r.assessedValueCents !== null),
      'ingestion must leave the read model populated, not just the ledger',
    ).toBe(true);
  });

  it('records zero persons — no current source supplies an owner name', async () => {
    /* Stated rather than skipped. SDAT parcel points has no owner-name field (all 114 checked)
       and VBN has none, so person resolution has no data to run on. This assertion documents a
       real gap; it is not evidence that person resolution works. */
    await enableSource('md.sdat_parcel_points');
    await ingestSource(db, registry(), 'md.sdat_parcel_points');
    const persons = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM persons`);
    expect(Number(persons[0]?.n ?? '0')).toBe(0);
  });
});

describe('resumability', () => {
  it('finishes un-normalized raw records without re-fetching', async () => {
    await enableSource('baltimore.vbn');
    const reg = registry();
    await ingestSource(db, reg, 'baltimore.vbn');

    const before = (await db.select().from(facts)).length;

    /* Simulate a crash between the two phases: payloads banked, normalization never ran. */
    await db.delete(facts);
    await db.update(rawRecords).set({ normalizedAt: null });

    const report = await ingestSource(db, reg, 'baltimore.vbn');
    expect(report.banked, 'nothing new to bank — the payloads were already there').toBe(0);
    expect(report.normalized, 'the pending records get finished').toBe(5);
    expect((await db.select().from(facts)).length).toBe(before);
  });
});
