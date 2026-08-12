import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeBuildingPermit } from '../baltimore-permits.js';
import { normalizeVacantBuildingNotice } from '../baltimore-vbn.js';
import { normalizeSdatParcelPoint, parseSdatDate } from '../sdat-parcel-points.js';
import type { NormalizedFact, RawRecord } from '../../types.js';

/**
 * Golden fixtures. Spec §9.1 MUST: "Every adapter ships with a committed golden fixture pair
 * (fixtures/<key>/input.json, fixtures/<key>/expected-facts.json). Upstream schema drift then
 * fails a test rather than silently writing garbage facts."
 *
 * `input.json` is a REAL captured response (2026-08-11), not a hand-written sample — a fixture
 * we invented could not detect drift in a shape we never saw.
 *
 * These tests touch no database, which is the point: they prove `normalize` is pure.
 *
 * Regenerate deliberately with `UPDATE_FIXTURES=1 pnpm vitest run packages/providers`, and
 * READ THE DIFF. A regenerated fixture that silently absorbs a schema change defeats the
 * mechanism entirely.
 */

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

/** Fixed so output is deterministic; a normalizer that read the clock would not be pure. */
const OBSERVED_AT = new Date('2026-08-11T00:00:00.000Z');

interface CapturedFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

function loadInput(key: string): RawRecord[] {
  const file = path.join(fixturesDir, key, 'input.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { features: CapturedFeature[] };
  return parsed.features.map((feature) => {
    const x = feature.geometry?.x;
    const y = feature.geometry?.y;
    return {
      sourceKey: key,
      sourceRecordId: null,
      payload: {
        ...feature.attributes,
        __centroid: typeof x === 'number' && typeof y === 'number' ? [x, y] : null,
      },
      observedAt: OBSERVED_AT,
    };
  });
}

function checkAgainstGolden(key: string, actual: NormalizedFact[]): void {
  const file = path.join(fixturesDir, key, 'expected-facts.json');
  const serialised = `${JSON.stringify(actual, null, 2)}\n`;

  if (process.env['UPDATE_FIXTURES'] === '1') {
    writeFileSync(file, serialised);
    return;
  }

  const expected = readFileSync(file, 'utf8');
  expect(
    JSON.parse(serialised),
    `${key} normalize() output drifted from its golden fixture — either upstream changed shape ` +
      `or the normalizer did. Inspect before regenerating.`,
  ).toEqual(JSON.parse(expected));
}

describe('md.sdat_parcel_points', () => {
  const records = loadInput('md.sdat_parcel_points');

  it('matches its golden fixture', () => {
    const facts = records.flatMap((record) => normalizeSdatParcelPoint(record));
    checkAgainstGolden('md.sdat_parcel_points', facts);
  });

  it('is pure — same input, same output', () => {
    const first = records.flatMap((r) => normalizeSdatParcelPoint(r));
    const second = records.flatMap((r) => normalizeSdatParcelPoint(r));
    expect(first).toEqual(second);
  });

  it('converts money to integer cents', () => {
    const facts = records.flatMap((r) => normalizeSdatParcelPoint(r));
    for (const fact of facts) {
      if (fact.predicate.endsWith('_cents')) {
        expect(Number.isInteger(fact.value), `${fact.predicate} must be integer cents`).toBe(true);
      }
    }
  });

  it('emits only epistemic=fact — the source is official_record', () => {
    const facts = records.flatMap((r) => normalizeSdatParcelPoint(r));
    expect(facts.every((f) => f.epistemic === 'fact')).toBe(true);
  });

  it('emits no owner name, because the source has none', () => {
    /* All 114 fields were checked on 2026-08-11: SDAT parcel points carries the owner's
       mailing address but no owner name. Person resolution needs another source. */
    const facts = records.flatMap((r) => normalizeSdatParcelPoint(r));
    expect(facts.every((f) => f.subject.ownerName === null)).toBe(true);
  });
});

describe('parseSdatDate — YYYYMMDD, not epoch', () => {
  it('parses a real value from the captured fixture', () => {
    expect(parseSdatDate('19950725')).toBe('1995-07-25');
  });

  it('rejects an impossible date rather than rolling it forward', () => {
    /* new Date(2025, 1, 30) silently becomes 2 March. A silently-wrong sale date is worse
       than a missing one. */
    expect(parseSdatDate('20250230')).toBeNull();
  });

  it.each([null, undefined, '', 'not-a-date', '1995', 0, 1779973980000])(
    'returns null for %s',
    (value) => {
      expect(parseSdatDate(value)).toBeNull();
    },
  );
});

describe('baltimore.vbn', () => {
  const records = loadInput('baltimore.vbn');

  it('matches its golden fixture', () => {
    const facts = records.flatMap((record) => normalizeVacantBuildingNotice(record));
    checkAgainstGolden('baltimore.vbn', facts);
  });

  it('is pure — same input, same output', () => {
    const first = records.flatMap((r) => normalizeVacantBuildingNotice(r));
    const second = records.flatMap((r) => normalizeVacantBuildingNotice(r));
    expect(first).toEqual(second);
  });

  it('retracts the signal when a notice is cancelled or abated', () => {
    /* A closed notice must emit `false`, not nothing — omitting it would leave the previous
       `true` standing as the current fact forever. Spec §4.4 closes this signal on
       cancel/abate. */
    const cancelled = normalizeVacantBuildingNotice({
      sourceKey: 'baltimore.vbn',
      sourceRecordId: 'X',
      payload: {
        Address: '100 TEST ST',
        BLOCKLOT: '0001 001',
        DateNotice: 1779973980000,
        DateCancel: 1786400520000,
        DateAbate: null,
        __centroid: null,
      },
      observedAt: OBSERVED_AT,
    });
    const open = cancelled.find((f) => f.predicate === 'vacancy.vbn_open');
    expect(open?.value).toBe(false);
  });

  it('reports an outstanding notice as open', () => {
    const facts = normalizeVacantBuildingNotice({
      sourceKey: 'baltimore.vbn',
      sourceRecordId: 'Y',
      payload: {
        Address: '100 TEST ST',
        BLOCKLOT: '0001 001',
        DateNotice: 1779973980000,
        DateCancel: null,
        DateAbate: null,
        __centroid: null,
      },
      observedAt: OBSERVED_AT,
    });
    expect(facts.find((f) => f.predicate === 'vacancy.vbn_open')?.value).toBe(true);
  });

  it('drops a record with neither an address nor a blocklot', () => {
    const facts = normalizeVacantBuildingNotice({
      sourceKey: 'baltimore.vbn',
      sourceRecordId: 'Z',
      payload: { Address: null, BLOCKLOT: null, DateNotice: null, __centroid: null },
      observedAt: OBSERVED_AT,
    });
    expect(facts).toEqual([]);
  });
});

describe('baltimore.permits', () => {
  const records = loadInput('baltimore.permits');

  function permit(payload: Record<string, unknown>): NormalizedFact[] {
    return normalizeBuildingPermit({
      sourceKey: 'baltimore.permits',
      sourceRecordId: 'TEST',
      payload: {
        Address: '100 TEST ST',
        BLOCKLOT: '0001 001',
        __centroid: null,
        ...payload,
      },
      observedAt: OBSERVED_AT,
    });
  }

  it('matches its golden fixture', () => {
    const facts = records.flatMap((record) => normalizeBuildingPermit(record));
    checkAgainstGolden('baltimore.permits', facts);
  });

  it('is pure — same input, same output', () => {
    const first = records.flatMap((r) => normalizeBuildingPermit(r));
    const second = records.flatMap((r) => normalizeBuildingPermit(r));
    expect(first).toEqual(second);
  });

  it('converts money to integer cents', () => {
    const facts = records.flatMap((r) => normalizeBuildingPermit(r));
    for (const fact of facts) {
      if (fact.predicate.endsWith('_cents')) {
        expect(Number.isInteger(fact.value), `${fact.predicate} must be integer cents`).toBe(true);
      }
    }
  });

  it('observes at the permit issue date, not the fetch time', () => {
    /* This is what makes the "most recent permit" predicates well defined. `recordFact`
       supersedes on observation time, so every fact from this adapter MUST carry IssuedDate —
       carrying the fetch time instead would make whichever record was normalized last win. */
    const facts = permit({ IssuedDate: 1782950400000, Cost: 5000, Description: 'FENCE' });
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact.observedAt.getTime()).toBe(1782950400000);
      expect(fact.observedAt).not.toEqual(OBSERVED_AT);
    }
  });

  it('drops an unissued permit rather than dating it now', () => {
    /* An application is not activity, and with no date there is nothing to order the supersede
       by — such a record would overwrite whichever permit is current. */
    expect(permit({ IssuedDate: null, Cost: 5000, Description: 'PENDING' })).toEqual([]);
  });

  it('records a zero cost rather than treating it as missing', () => {
    /* No-fee permits are real and common; conflating $0 with "unknown" would lose them. */
    const facts = permit({ IssuedDate: 1782950400000, Cost: 0, Description: 'X' });
    expect(facts.find((f) => f.predicate === 'permit.last_cost_cents')?.value).toBe(0);
  });

  it('omits cost entirely when the field is absent', () => {
    const facts = permit({ IssuedDate: 1782950400000, Cost: null, Description: 'X' });
    expect(facts.some((f) => f.predicate === 'permit.last_cost_cents')).toBe(false);
  });

  it('collapses the intake form CRLF runs in the description', () => {
    /* Real captured value: descriptions arrive with embedded CRLF and clerk instructions. */
    const facts = permit({
      IssuedDate: 1782950400000,
      Description: 'PLEASE AMEND.\r\n\r\nEXTERIOR ALTERATION,   to include   fence.',
    });
    expect(facts.find((f) => f.predicate === 'permit.last_description')?.value).toBe(
      'PLEASE AMEND. EXTERIOR ALTERATION, to include fence.',
    );
  });

  it('clips a description to the predicate schema bound', () => {
    const facts = permit({ IssuedDate: 1782950400000, Description: 'A'.repeat(3000) });
    const value = facts.find((f) => f.predicate === 'permit.last_description')?.value;
    expect(typeof value === 'string' && value.length).toBe(2000);
  });

  it('drops a record with neither an address nor a blocklot', () => {
    const facts = normalizeBuildingPermit({
      sourceKey: 'baltimore.permits',
      sourceRecordId: 'Z',
      payload: { Address: null, BLOCKLOT: null, IssuedDate: 1782950400000, __centroid: null },
      observedAt: OBSERVED_AT,
    });
    expect(facts).toEqual([]);
  });

  it('emits only epistemic=fact — the source is official_record', () => {
    const facts = records.flatMap((r) => normalizeBuildingPermit(r));
    expect(facts.every((f) => f.epistemic === 'fact')).toBe(true);
  });
});
