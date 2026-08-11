import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
