import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DataSourceAdapter, NormalizedFact, RawRecord, SourceTier } from '@magnolia/providers';

/**
 * A `DataSourceAdapter` that replays a committed golden fixture instead of calling a service.
 *
 * Spec §9: "Every interface has a `Fake` implementation in `packages/testkit` used by all
 * tests." This is what lets AT-2 exercise the whole ingestion pipeline — fetch, dedupe,
 * normalize, resolve, record — with no network and no dependence on a Baltimore endpoint being
 * up, while still running the REAL `normalize` against a REAL captured response.
 */

export interface FixtureAdapterOptions {
  key: string;
  tier?: SourceTier;
  /** Directory holding `input.json`, as captured from the live service. */
  fixtureDir: string;
  normalize: (raw: RawRecord) => NormalizedFact[];
  /** Fixed so repeated runs produce identical records — AT-2 depends on that. */
  observedAt?: Date;
}

interface CapturedFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

export function createFixtureAdapter(options: FixtureAdapterOptions): DataSourceAdapter {
  const observedAt = options.observedAt ?? new Date('2026-08-11T00:00:00.000Z');

  const load = (): RawRecord[] => {
    const file = path.join(options.fixtureDir, 'input.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { features: CapturedFeature[] };
    return parsed.features.map((feature) => {
      const x = feature.geometry?.x;
      const y = feature.geometry?.y;
      return {
        sourceKey: options.key,
        sourceRecordId: null,
        payload: {
          ...feature.attributes,
          __centroid: typeof x === 'number' && typeof y === 'number' ? [x, y] : null,
        },
        observedAt,
      };
    });
  };

  return {
    key: options.key,
    tier: options.tier ?? 'official_record',
    scrapingAllowed: true,
    costModel: { perCallCents: 0, monthlyCents: 0 },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *fetch() {
      for (const record of load()) yield record;
    },
    normalize: options.normalize,
    healthCheck: () =>
      Promise.resolve({ ok: true, detail: 'fixture adapter', checkedAt: new Date() }),
  };
}
