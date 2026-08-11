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

/** An untouched payload from a source. Ingestors write these; normalizers read them. */
export interface RawRecord {
  sourceKey: string;
  /** Natural key at the source, when it has one. */
  sourceRecordId: string | null;
  payload: Record<string, unknown>;
  /** When the source observed it — not when we fetched it. */
  observedAt: Date;
}

/**
 * A property named by natural key rather than id.
 *
 * Carries enough to both *resolve* an existing property (spec §4.3 matches on apn, then
 * address hash, then fuzzy) and to *create* one if none matches, without a second trip to the
 * source.
 */
export interface PropertyRef {
  apn: string | null;
  blocklot: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateCode: string;
  postalCode: string | null;
  /** `[longitude, latitude]`, WGS84. Used as a confirming attribute for fuzzy matches. */
  centroid: [number, number] | null;
  /** Owner name where the source supplies one; the other confirming attribute. */
  ownerName: string | null;
}

/** A fact whose subject is still a natural key. */
export interface NormalizedFact {
  subject: PropertyRef;
  predicate: string;
  value: unknown;
  epistemic: EpistemicLevel;
  observedAt: Date;
  confidence: number;
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
