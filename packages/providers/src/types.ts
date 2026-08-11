/**
 * Data-source adapter contract. Spec §9.1.
 *
 * DELIBERATE DIVERGENCE from the spec's literal signature, recorded in DIVERGENCES.md:
 *
 *   §9.1 declares `normalize(raw: RawRecord): FactDraft[]` and separately requires that
 *   `normalize` be pure and synchronous. Those cannot both hold — `FactDraft` carries a
 *   `subjectId`, a property UUID that only exists after a database lookup.
 *
 * So `normalize` returns `NormalizedFact[]`, which names its subject by natural key
 * (`PropertyRef`) rather than by id. The ingestion pipeline resolves that reference and then
 * calls `recordFact` with a real `subjectId`.
 *
 * Keeping `normalize` pure is what makes golden-fixture testing possible at all: the fixture
 * test runs it with no database, so upstream schema drift fails a test instead of silently
 * writing garbage facts.
 */

export type SourceTier =
  'official_record' | 'commercial_data' | 'secondary' | 'derived' | 'ai_inference' | 'human';

export type EpistemicLevel = 'fact' | 'prediction' | 'inference';

/* Domain types live in packages/core (spec §3.1); imported and re-exported here so the adapter
   contract still reads as one surface. Defining them here instead would make core depend on
   providers, which already depends on core. */
import type { NormalizedFact, PropertyRef } from '@magnolia/core';

export type { NormalizedFact, PropertyRef };

/** An untouched payload from a source. Ingestors write these; normalizers read them. */
export interface RawRecord {
  sourceKey: string;
  /** Natural key at the source, when it has one. */
  sourceRecordId: string | null;
  payload: Record<string, unknown>;
  /** When the source observed it — not when we fetched it. */
  observedAt: Date;
}

export interface HealthStatus {
  ok: boolean;
  detail: string;
  checkedAt: Date;
}

export interface DataSourceAdapter {
  key: string;
  tier: SourceTier;
  /**
   * Whether automated access is permitted. Mirrors `sources.scraping_allowed`; the registry
   * refuses to run an adapter whose database row says false, so this is a declaration rather
   * than the enforcement point.
   */
  scrapingAllowed: boolean;
  costModel: { perCallCents: number; monthlyCents: number };

  fetch: (cursor: string | null, signal: AbortSignal) => AsyncIterable<RawRecord>;

  /** MUST be pure and side-effect-free. Tested against committed golden fixtures. */
  normalize: (raw: RawRecord) => NormalizedFact[];

  healthCheck: () => Promise<HealthStatus>;
}
