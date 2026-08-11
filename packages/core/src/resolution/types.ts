import type { EpistemicLevel } from '../facts/record-fact.js';

/**
 * Domain types shared by adapters and resolution.
 *
 * These live in `packages/core` rather than `packages/providers` because spec §3.1 puts domain
 * types in core, and because `providers` already depends on `core` — defining them the other
 * way round would make the workspace dependency circular. `providers` re-exports them so the
 * adapter contract still reads as one surface.
 */

/**
 * A property named by natural key rather than id.
 *
 * Carries enough both to *resolve* an existing property (spec §4.3 matches on apn, then address
 * hash, then fuzzy plus a confirming attribute) and to *create* one when nothing matches,
 * without a second trip to the source.
 */
export interface PropertyRef {
  apn: string | null;
  blocklot: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateCode: string;
  postalCode: string | null;
  /** `[longitude, latitude]`, WGS84. A confirming attribute for fuzzy matches. */
  centroid: [number, number] | null;
  /** The other confirming attribute, where the source supplies one. */
  ownerName: string | null;
}

/** A fact whose subject is still a natural key, as produced by a pure `normalize()`. */
export interface NormalizedFact {
  subject: PropertyRef;
  predicate: string;
  value: unknown;
  epistemic: EpistemicLevel;
  observedAt: Date;
  confidence: number;
}
