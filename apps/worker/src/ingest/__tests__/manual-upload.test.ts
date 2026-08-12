import type { NormalizedFact } from '@magnolia/core';
import type { RawRecord } from '@magnolia/providers';
import { facts, properties, rawRecords, seed, sources, type Db } from '@magnolia/db';
import { createTestDb, type TestDb } from '@magnolia/testkit';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ingestManualUpload,
  ManualUploadError,
  parseCsv,
  TRANSCRIPTION_CONFIDENCE_FACTOR,
} from '../manual-upload.js';

/**
 * Manual upload. BUILD_PLAN M2.6.
 *
 * The two things worth proving are about provenance, not parsing: that an upload names its
 * operator, and that a bulk transcription does not silently acquire the override authority §4.2
 * grants to `human`.
 */

let harness: TestDb | undefined;
let db: Db;

const CSV = [
  'address,year_built',
  '"2831 GUILFORD AVE",1920',
  '"1234 N CHARLES ST",1900',
  '"900 S BROADWAY",1885',
].join('\n');

/** CSV cells arrive as strings, but `payload` is `Record<string, unknown>` — narrow, don't cast. */
function cell(payload: Record<string, unknown>, column: string): string {
  const value = payload[column];
  return typeof value === 'string' ? value : '';
}

/** Stands in for a real adapter's normalizer — pure, synchronous, same contract. */
function normalize(raw: RawRecord): NormalizedFact[] {
  const address = cell(raw.payload, 'address');
  const year = Number(cell(raw.payload, 'year_built'));
  if (address === '' || !Number.isFinite(year)) return [];
  return [
    {
      subject: {
        apn: null,
        blocklot: null,
        addressLine1: address,
        addressLine2: null,
        city: 'BALTIMORE',
        stateCode: 'MD',
        postalCode: null,
        centroid: null,
        ownerName: null,
      },
      predicate: 'property.year_built',
      value: year,
      epistemic: 'fact',
      observedAt: raw.observedAt,
      confidence: 0.9,
    },
  ];
}

function upload(overrides: Partial<Parameters<typeof ingestManualUpload>[1]> = {}) {
  return ingestManualUpload(db, {
    sourceKey: 'baltimore.tax_sale',
    csv: CSV,
    uploadedBy: 'operator@magnolia.test',
    provenance: 'transcribed',
    origin: 'FY2026-tax-sale-list.csv',
    observedAt: new Date('2026-06-01T00:00:00Z'),
    normalize,
    ...overrides,
  });
}

async function sourceKeyOfFacts(): Promise<string[]> {
  const rows = await db.execute<{ key: string }>(sql`
    SELECT DISTINCT s.key FROM facts f JOIN sources s ON s.id = f.source_id ORDER BY s.key
  `);
  return rows.map((row) => row.key);
}

beforeAll(async () => {
  harness = await createTestDb('manual-upload');
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
});

describe('an upload must be signed', () => {
  it('refuses an upload with no operator', async () => {
    /* The facts that result carry human provenance, and nothing else records who supplied
       them. An unsigned upload is not acceptable at any tier. */
    await expect(upload({ uploadedBy: '   ' })).rejects.toBeInstanceOf(ManualUploadError);
  });

  it('records the operator, origin and originating dataset on the fetch row', async () => {
    await upload();
    const [fetch] = await db.execute<{ storage_uri: string }>(
      sql`SELECT storage_uri FROM source_fetches LIMIT 1`,
    );
    expect(fetch?.storage_uri).toContain('operator@magnolia.test');
    expect(fetch?.storage_uri).toContain('FY2026-tax-sale-list.csv');
    expect(fetch?.storage_uri).toContain('baltimore.tax_sale');
  });

  it('refuses a source that is not seeded', async () => {
    await expect(upload({ sourceKey: 'baltimore.nonexistent' })).rejects.toBeInstanceOf(
      ManualUploadError,
    );
  });
});

describe('ToS-restricted sources — manual upload is the PERMITTED route', () => {
  it.each(['md.case_search', 'md.land_records'])(
    'accepts a manual upload for %s despite scraping_allowed=false',
    async (key) => {
      /*
       * The mirror of the scheduler test. Spec §4.5 keeps these non-scrapable AND says they are
       * "reachable only by manual operator lookup" — so requiring scraping_allowed here would
       * forbid the one route the spec permits. Automated access stays refused by
       * `registry.requireRunnable`; this path is gated on an operator instead.
       */
      const report = await ingestManualUpload(db, {
        sourceKey: key,
        csv: CSV,
        uploadedBy: 'operator@magnolia.test',
        provenance: 'operator',
        origin: 'hand-transcribed lookup',
        observedAt: new Date('2026-06-01T00:00:00Z'),
        normalize,
      });
      expect(report.banked).toBe(3);
      expect(report.errors).toEqual([]);
    },
  );
});

describe('provenance decides who wins a conflict', () => {
  it("records an operator's own lookup against magnolia.human", async () => {
    /* §4.2 ranks human highest — an operator who looked at the thing overrides every feed. */
    await upload({ provenance: 'operator' });
    expect(await sourceKeyOfFacts()).toEqual(['magnolia.human']);
  });

  it('records a bulk transcription against the ORIGINATING source, not as human', async () => {
    /*
     * The case that matters. A nine-thousand-row transcription landing as tier `human` would
     * outrank SDAT permanently, and a single typo in the file could then never be corrected by
     * any automated source — the fix would itself have to be manual, forever. A transcription is
     * still that source's data; the operator only moved the bytes.
     */
    await upload({ provenance: 'transcribed' });
    expect(await sourceKeyOfFacts()).toEqual(['baltimore.tax_sale']);
  });

  it('discounts confidence for transcription risk', async () => {
    /* The tier still says "official record", which is true. The confidence says we are slightly
       less sure it was copied correctly, which is also true. */
    await upload({ provenance: 'transcribed' });
    const rows = await db.select({ confidence: facts.confidence }).from(facts);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.confidence).toBeCloseTo(0.9 * TRANSCRIPTION_CONFIDENCE_FACTOR, 4);
    }
  });

  it('keeps the originating dataset traceable even under human provenance', async () => {
    /* facts.source_id says `magnolia.human`, which loses the dataset — so the raw record has to
       carry it, or §13.3 replay could not say what the operator was reading. */
    await upload({ provenance: 'operator' });
    const [row] = await db.select({ payload: rawRecords.payload }).from(rawRecords).limit(1);
    const envelope = (row?.payload as { __upload?: Record<string, unknown> }).__upload;
    expect(envelope?.['originatingSourceKey']).toBe('baltimore.tax_sale');
    expect(envelope?.['uploadedBy']).toBe('operator@magnolia.test');
  });
});

describe('it is the same pipeline, not a second one', () => {
  it('resolves properties and records facts through the normal path', async () => {
    const report = await upload();
    expect(report.fetched).toBe(3);
    expect(report.banked).toBe(3);
    expect(report.normalized).toBe(3);
    expect(report.propertiesCreated).toBe(3);
    expect(report.errors).toEqual([]);
    expect(await db.select().from(properties)).toHaveLength(3);
  });

  it('projects the read model, exactly as an automated load does', async () => {
    await upload();
    const rows = await db.select().from(properties);
    expect(rows.every((row) => row.yearBuilt !== null)).toBe(true);
  });

  it('is idempotent — re-uploading the same file banks nothing new (invariant 7)', async () => {
    await upload();
    const second = await upload();
    expect(second.banked, 'raw_records_dedupe covers manual uploads too').toBe(0);
    expect(second.normalized).toBe(0);
    expect(await db.select().from(properties)).toHaveLength(3);
  });
});

describe('a malformed file is rejected, not partially absorbed', () => {
  it('refuses a ragged row rather than misaligning columns', async () => {
    /* A short row would otherwise shift values into the wrong predicate — a year_built read out
       of an address column. Rejecting the file is the only safe answer. */
    const ragged = ['address,year_built', '"2831 GUILFORD AVE",1920', '"1234 N CHARLES ST"'].join(
      '\n',
    );
    await expect(upload({ csv: ragged })).rejects.toBeInstanceOf(ManualUploadError);
  });

  it('refuses a file with a header and no rows', async () => {
    await expect(upload({ csv: 'address,year_built' })).rejects.toBeInstanceOf(ManualUploadError);
  });

  it('parses quoted fields containing commas', () => {
    const rows = parseCsv('address,note\n"100 MAIN ST, REAR","a, b"');
    expect(rows[0]?.['address']).toBe('100 MAIN ST, REAR');
    expect(rows[0]?.['note']).toBe('a, b');
  });

  it('strips a UTF-8 BOM — Excel writes one and it corrupts the first header', () => {
    const rows = parseCsv('﻿address,year_built\n"100 MAIN ST",1900');
    expect(Object.keys(rows[0] ?? {})).toContain('address');
  });
});

describe('the seeded posture is unaffected', () => {
  it('does not enable the source it uploaded to', async () => {
    /* Invariant 8. A manual upload is a one-off act by an operator; it must not quietly turn on
       an automated feed as a side effect. */
    await upload();
    const [row] = await db
      .select({ enabled: sources.enabled, scraping: sources.scrapingAllowed })
      .from(sources)
      .where(eq(sources.key, 'baltimore.tax_sale'));
    expect(row?.enabled).toBe(false);
    expect(row?.scraping).toBe(true); // unchanged from the seed, not flipped by the upload
  });
});
