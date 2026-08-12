import {
  createAdapterRegistry,
  createBaltimorePermitsAdapter,
  createBaltimoreVbnAdapter,
  createSdatParcelPointsAdapter,
  type AdapterRegistry,
} from '@magnolia/providers';

/**
 * The production adapter registry.
 *
 * Until now adapters were only ever constructed inside tests, which meant the shipped worker had
 * no way to run one. This is the single place that knows which adapters exist for real.
 *
 * **Only verified sources appear here.** BUILD_PLAN M2's DoD requires each endpoint be verified
 * before its adapter is written, and `docs/SOURCE_VERIFICATION.md` is the record. Three of the
 * sixteen seeded sources turned out to be publishing nothing while still answering HTTP 200
 * (Foreclosure Filings, Tax Sale, Receivership), so absence from this list is usually a finding
 * rather than an omission — see the file for which and why.
 *
 * Registration is not permission. Every entry here is still refused at run time unless its
 * `sources` row is enabled, its `source.<key>` kill switch is on, and `scraping_allowed` is
 * true (invariant 8, spec §4.5). The seeded posture is that none of that holds.
 */

export interface ProductionRegistryOptions {
  /** Sent on every outbound request so the operator is identifiable to the services we call. */
  userAgent: string;
}

export function createProductionRegistry(options: ProductionRegistryOptions): AdapterRegistry {
  const { userAgent } = options;

  return createAdapterRegistry([
    /* Verified 2026-08-11 — the state's MapServer, not the FeatureServer the seed first named. */
    createSdatParcelPointsAdapter({ userAgent }),
    /* Verified 2026-08-11 — 387 notices since 2026-06-01. */
    createBaltimoreVbnAdapter({ userAgent }),
    /* Verified 2026-08-11 — 3,641 permits issued since 2026-07-01. */
    createBaltimorePermitsAdapter({ userAgent }),
  ]);
}
