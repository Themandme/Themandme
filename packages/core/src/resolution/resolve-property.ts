import { properties } from '@magnolia/db';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { addressHash, normalizeAddress, type NormalizedAddress } from '../addresses/normalize.js';
import { emitEvent } from '../events/outbox.js';
import type { DbOrTx } from '../facts/record-fact.js';
import type { ResolutionParams } from './market-params.js';
import type { PropertyRef } from './types.js';

/**
 * Property entity resolution. Spec §4.3, BUILD_PLAN M2.3.
 *
 * Resolution order: `market_id + apn`, then `market_id + address_hash`, then fuzzy address
 * similarity **plus a confirming attribute**. Below that, create a new property and emit
 * `property.possible_duplicate` for review.
 *
 * "Never auto-merge on fuzzy alone" is the rule the spec states outright, and it is the reason
 * the address normalizer treats half-numbers as significant: `1234` and `1234 1/2` are
 * different houses on a Baltimore block, and they must not arrive here looking identical.
 * Merging two properties is not reversible in the way splitting them is — one wrong merge
 * silently attributes one owner's distress to another's house.
 *
 * ## Tier 3 diverges from spec §4.3, deliberately — see packages/db/DIVERGENCES.md
 *
 * The spec asks for trigram similarity >= 0.92 on the address plus a centroid within 50 m, and
 * treats the similarity score as the thing that decides. Measured against real Baltimore data,
 * a score cannot carry that weight in either direction:
 *
 *   - **Similarity cannot separate house numbers.** `2831` vs `2833 GUILFORD AVE` scores 0.800,
 *     just under the threshold — near enough that any downward tuning merges neighbours.
 *   - **The radius cannot separate house numbers either.** Adjacent rowhouses sit 4.4-5.5 m
 *     apart, so a 50 m radius "confirms" about ten neighbours. Both mechanisms fail on the same
 *     pair, so neither can backstop the other.
 *   - **Similarity cannot separate street names.** The scores for pairs that must match and
 *     pairs that must not overlap completely: `GUILFORD`/`GUILFRD` (a typo, must match) scores
 *     0.545 while `LOMBARD`/`LOMBARDY` (different streets, must not) scores 0.700, and
 *     `SAINT PAUL`/`ST PAUL` scores 0.462. No threshold separates the two sets.
 *   - **Similarity actively misleads on directionals.** `N CHARLES ST` vs `S CHARLES ST` scores
 *     0.786 — higher than a genuine typo — and in Baltimore, where numbering is symmetric about
 *     Baltimore St, 100 N Charles and 100 S Charles are both real and are different buildings.
 *
 * So each mechanism is used only where it actually discriminates, and the score stops deciding
 * anything:
 *
 *   - **House number, fraction and unit: matched exactly.** Structural, not scored. This is what
 *     makes an adjacent-rowhouse merge impossible rather than threshold-dependent.
 *   - **Directional and suffix: must be equal or absent on one side.** A source that omits them
 *     must not block a match, but two *different* values are two different streets — which is
 *     the N-vs-S case above, now rejected structurally instead of scoring 0.786.
 *   - **Street name: confirmed by the centroid, never by the score.** The radius is useless at
 *     5 m (neighbours) but decisive at street scale, since two different streets are hundreds of
 *     metres apart. `LOMBARD` vs `LOMBARDY` fails on distance even though it scores 0.700.
 *   - **Trigram similarity is demoted to a recall prefilter** — it decides which rows are worth
 *     examining, not which rows match. Its threshold is therefore a performance knob with a
 *     recall floor, and lowering it can never cause a merge; see market-params.ts.
 *
 * A merge at this tier now requires the house number, fraction and unit to be identical, the
 * directional and suffix to be compatible, *and* the centroids to agree — so no text score, at
 * any threshold, can produce one on its own.
 *
 * MUST be idempotent (spec §4.3): re-running ingestion over the same source data produces zero
 * new properties. Half of AT-2 rests on this.
 */

export type ResolutionVia = 'apn' | 'address_hash' | 'fuzzy_confirmed';

export type ResolveResult =
  | { created: false; propertyId: string; via: ResolutionVia }
  | { created: true; propertyId: string; possibleDuplicateOf: string | null };

export interface ResolveOptions extends ResolutionParams {
  marketId: string;
  /** Emit `property.possible_duplicate` when a fuzzy candidate went unconfirmed. Default true. */
  emitDuplicateEvent?: boolean;
}

/**
 * The part of an address that may legitimately vary in spelling between two records.
 *
 * Used only for the recall prefilter's score, never for a match decision. The house number is
 * excluded because it is pinned exactly by `sameDwelling` — leaving it in would add a constant
 * block of matching trigrams to every pair, which is exactly what made 0.92 look like a
 * reasonable threshold when it was in fact almost unreachable.
 */
function streetPortion(parsed: NormalizedAddress): string {
  return [parsed.predirectional, parsed.streetName, parsed.suffix, parsed.postdirectional]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');
}

/** Equal, or absent on one side. Absence is missing data; a difference is a real difference. */
function compatible(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/**
 * Could two parsed addresses name the same dwelling?
 *
 * This is the safeguard, not the similarity score. Two classes of component, treated differently
 * on purpose:
 *
 * **Pinned exactly** — house number, fraction, unit. Absence is *not* compatibility here:
 * `1234` vs `1234 1/2` and `… AVE` vs `… AVE REAR` are different dwellings in Baltimore's
 * rowhouse stock, and treating a missing fraction as a wildcard would merge them. Every source
 * that supplies an address supplies the house number, so there is no missing-data case to
 * accommodate.
 *
 * **Compatible-or-absent** — directional and suffix. Sources genuinely differ in whether they
 * carry these, so requiring equality would reject real matches. But two *different* values name
 * two different streets: `N CHARLES` vs `S CHARLES` is the case that trigram similarity scores
 * at 0.786 and would otherwise wave through.
 *
 * The street *name* is deliberately not checked here — no text comparison separates a typo from
 * a different street (see the header), so the centroid decides it instead.
 */
function sameDwelling(a: NormalizedAddress, b: NormalizedAddress): boolean {
  return (
    a.houseNumber === b.houseNumber &&
    a.fraction === b.fraction &&
    a.unitDesignator === b.unitDesignator &&
    a.unitNumber === b.unitNumber &&
    compatible(a.predirectional, b.predirectional) &&
    compatible(a.postdirectional, b.postdirectional) &&
    compatible(a.suffix, b.suffix)
  );
}

/** Postgres unique-violation, anywhere in the error chain. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (typeof current === 'object' && (current as { code?: string }).code === '23505') return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

/**
 * Resolve a `PropertyRef` to a property id, creating one when nothing matches.
 *
 * Should be called inside the caller's transaction so that the property, its facts and any
 * `property.possible_duplicate` event commit together.
 */
export async function resolveProperty(
  tx: DbOrTx,
  ref: PropertyRef,
  options: ResolveOptions,
): Promise<ResolveResult> {
  const { marketId } = options;
  const parsed = normalizeAddress(ref.addressLine1);
  const addressNorm = parsed.normalized;
  const hash = addressHash(addressNorm, ref.postalCode);

  // ── Tier 1: APN ──────────────────────────────────────────────────────────────────────
  if (ref.apn !== null && ref.apn !== '') {
    const [byApn] = await tx
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.marketId, marketId), eq(properties.apn, ref.apn)))
      .limit(1);
    if (byApn !== undefined) return { created: false, propertyId: byApn.id, via: 'apn' };
  }

  // ── Tier 2: exact normalized address ─────────────────────────────────────────────────
  const [byHash] = await tx
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.marketId, marketId), eq(properties.addressHash, hash)))
    .limit(1);
  if (byHash !== undefined) {
    return { created: false, propertyId: byHash.id, via: 'address_hash' };
  }

  // ── Tier 3: same dwelling + a confirming attribute ───────────────────────────────────
  let unconfirmedCandidate: string | null = null;

  /*
   * No parseable house number means there is nothing to pin, and the remaining text is just a
   * street — which would match every property on it. Skip the tier outright: a duplicate that
   * reaches a human is recoverable, a silent merge is not.
   */
  const street = streetPortion(parsed);
  if (parsed.houseNumber !== null && street !== '') {
    const centroidWkt =
      ref.centroid === null
        ? null
        : `SRID=4326;POINT(${String(ref.centroid[0])} ${String(ref.centroid[1])})`;

    /* The house-number prefix is the real candidate generator: it reduces the market to the rows
       that could possibly be this dwelling before anything is scored. `sameDwelling` below still
       has to run, since a prefix match alone would admit "2831" against "2831 1/2". */
    const housePrefix = `${parsed.houseNumber} %`;

    const candidates = await tx.execute<{
      id: string;
      address_norm: string;
      similarity: number;
      centroid_confirms: boolean | null;
    }>(sql`
      SELECT p.id,
             p.address_norm,
             similarity(p.address_norm, ${addressNorm}) AS similarity,
             CASE
               WHEN ${centroidWkt}::text IS NULL OR p.centroid IS NULL THEN NULL
               ELSE ST_DWithin(
                 p.centroid::geography,
                 ${centroidWkt}::geometry::geography,
                 ${options.centroidConfirmMetres}
               )
             END AS centroid_confirms
      FROM ${properties} p
      WHERE p.market_id = ${marketId}
        AND (p.address_norm = ${parsed.houseNumber} OR p.address_norm LIKE ${housePrefix})
      ORDER BY similarity DESC
      LIMIT 25
    `);

    /* The structural gate. A different house number, a half-number, a REAR unit or an opposing
       directional is a different dwelling regardless of how the text scores, so these are
       rejected before any score is consulted. Two survivors requires the same number and unit on
       two differently-named streets, which is rare — the scored set below is normally empty or
       one row. */
    const viable = candidates
      .map((candidate) => {
        const candidateParsed = normalizeAddress(candidate.address_norm);
        return { candidate, parsed: candidateParsed, street: streetPortion(candidateParsed) };
      })
      .filter((entry) => entry.street !== '' && sameDwelling(parsed, entry.parsed));

    if (viable.length > 0) {
      /* Recall floor, not a match decision — see the header. A candidate below the threshold is
         too textually distant to be worth confirming; one above it still has to be confirmed by
         the centroid, so lowering this value can never by itself produce a merge.

         Scored in one round-trip rather than one per candidate, and in Postgres rather than JS:
         reimplementing pg_trgm here would drift from the operator the threshold was measured
         against. */
      const streetList = sql.join(
        viable.map((entry) => sql`${entry.street}`),
        sql`, `,
      );
      /* `ord` is bigint and `street_similarity` is real; the driver hands bigint back as a
         string, so both are widened here rather than asserted to be numbers. */
      const scores = await tx.execute<{
        ord: string | number;
        street_similarity: string | number;
      }>(sql`
        SELECT t.ord, similarity(t.cand, ${street}) AS street_similarity
        FROM unnest(ARRAY[${streetList}]::text[]) WITH ORDINALITY AS t(cand, ord)
      `);
      const byOrdinal = new Map(
        scores.map((row) => [Number(row.ord), Number(row.street_similarity)]),
      );

      for (const [index, { candidate }] of viable.entries()) {
        const score = byOrdinal.get(index + 1);
        if (score === undefined || score < options.fuzzyThreshold) continue;

        /*
         * The confirming attribute — and, for the street name, the *only* discriminator, since
         * no text comparison separates a typo from a different street. It works here precisely
         * where it failed on house numbers: neighbours are 5 m apart, but two differently-named
         * streets are hundreds of metres apart, so `LOMBARD` vs `LOMBARDY` fails on distance
         * despite scoring 0.700.
         *
         * Spec §4.3 allows a matching owner name as a second confirmer. It is not implemented,
         * because no *usable* source supplies one: SDAT parcel points has no owner-name field at
         * all (all 114 checked) and VBN has none either. Baltimore's tax-sale service does carry
         * owner names on every row, but its data is frozen at FY2021 — a five-year-old owner name
         * is not a confirming attribute. See docs/SOURCE_VERIFICATION.md.
         *
         * The branch is deliberately NOT stubbed in: an unreachable path cannot be tested, and
         * one that silently never fires is worse than an absent one that is documented. Add it
         * with the source that makes it testable.
         */
        if (candidate.centroid_confirms === true) {
          return { created: false, propertyId: candidate.id, via: 'fuzzy_confirmed' };
        }
        unconfirmedCandidate ??= candidate.id;
      }
    }
  }

  // ── Create, letting the database arbitrate races ─────────────────────────────────────
  const id = uuidv7();
  const values = {
    id,
    marketId,
    apn: ref.apn,
    blocklot: ref.blocklot,
    addressLine1: ref.addressLine1,
    addressLine2: ref.addressLine2,
    city: ref.city,
    stateCode: ref.stateCode,
    postalCode: ref.postalCode,
    addressNorm,
    addressHash: hash,
    ...(ref.centroid === null
      ? {}
      : { centroid: `SRID=4326;POINT(${String(ref.centroid[0])} ${String(ref.centroid[1])})` }),
  };

  try {
    await tx.insert(properties).values(values);
  } catch (error) {
    /* Two concurrent resolutions of one address: `properties_address_key` and
       `properties_apn_key` decide, not the application. Re-select the winner rather than
       retrying blindly — the same posture as facts_one_current_per_source. */
    if (!isUniqueViolation(error)) throw error;

    const [winner] = await tx
      .select({ id: properties.id })
      .from(properties)
      .where(and(eq(properties.marketId, marketId), eq(properties.addressHash, hash)))
      .limit(1);
    if (winner !== undefined) {
      return { created: false, propertyId: winner.id, via: 'address_hash' };
    }

    if (ref.apn !== null && ref.apn !== '') {
      const [byApnRace] = await tx
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.marketId, marketId), eq(properties.apn, ref.apn)))
        .limit(1);
      if (byApnRace !== undefined) {
        return { created: false, propertyId: byApnRace.id, via: 'apn' };
      }
    }
    throw error;
  }

  if (unconfirmedCandidate !== null && options.emitDuplicateEvent !== false) {
    /* Spec §4.3: "create a new property and emit property.possible_duplicate for review.
       Never auto-merge on fuzzy alone." The event is the review path — without it the near
       match is simply lost, and the operator never learns the two rows might be one house. */
    await emitEvent(tx, {
      topic: 'property.possible_duplicate',
      subjectType: 'property',
      subjectId: id,
      payload: {
        createdPropertyId: id,
        possibleDuplicateOf: unconfirmedCandidate,
        addressNorm,
        reason: 'fuzzy address match above threshold with no confirming attribute',
      },
      dedupeKey: `property.possible_duplicate:${id}:${unconfirmedCandidate}`,
    });
  }

  return { created: true, propertyId: id, possibleDuplicateOf: unconfirmedCandidate };
}
