import { properties } from '@magnolia/db';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { addressHash, normalizeAddress } from '../addresses/normalize.js';
import { emitEvent } from '../events/outbox.js';
import type { DbOrTx } from '../facts/record-fact.js';
import type { PropertyRef } from './types.js';

/**
 * Property entity resolution. Spec §4.3, BUILD_PLAN M2.3.
 *
 * Resolution order: `market_id + apn`, then `market_id + address_hash`, then fuzzy address
 * similarity >= 0.92 **plus a confirming attribute**. Below that, create a new property and
 * emit `property.possible_duplicate` for review.
 *
 * "Never auto-merge on fuzzy alone" is the rule the spec states outright, and it is the reason
 * the address normalizer treats half-numbers as significant: `1234` and `1234 1/2` are
 * different houses on a Baltimore block, and they must not arrive here looking identical.
 * Merging two properties is not reversible in the way splitting them is — one wrong merge
 * silently attributes one owner's distress to another's house.
 *
 * MUST be idempotent (spec §4.3): re-running ingestion over the same source data produces zero
 * new properties. Half of AT-2 rests on this.
 */

/** Spec §4.3: `pg_trgm` similarity at or above this is a fuzzy candidate — never a match alone. */
export const FUZZY_THRESHOLD = 0.92;

/** Spec §4.3: a parcel centroid within this many metres confirms a fuzzy candidate. */
export const CENTROID_CONFIRM_METRES = 50;

export type ResolutionVia = 'apn' | 'address_hash' | 'fuzzy_confirmed';

export type ResolveResult =
  | { created: false; propertyId: string; via: ResolutionVia }
  | { created: true; propertyId: string; possibleDuplicateOf: string | null };

export interface ResolveOptions {
  marketId: string;
  /** Emit `property.possible_duplicate` when a fuzzy candidate went unconfirmed. Default true. */
  emitDuplicateEvent?: boolean;
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

  // ── Tier 3: fuzzy address + a confirming attribute ───────────────────────────────────
  let unconfirmedCandidate: string | null = null;

  if (addressNorm !== '') {
    const centroidWkt =
      ref.centroid === null
        ? null
        : `SRID=4326;POINT(${String(ref.centroid[0])} ${String(ref.centroid[1])})`;

    const candidates = await tx.execute<{
      id: string;
      similarity: number;
      centroid_confirms: boolean | null;
    }>(sql`
      SELECT p.id,
             similarity(p.address_norm, ${addressNorm}) AS similarity,
             CASE
               WHEN ${centroidWkt}::text IS NULL OR p.centroid IS NULL THEN NULL
               ELSE ST_DWithin(
                 p.centroid::geography,
                 ${centroidWkt}::geometry::geography,
                 ${CENTROID_CONFIRM_METRES}
               )
             END AS centroid_confirms
      FROM ${properties} p
      WHERE p.market_id = ${marketId}
        AND similarity(p.address_norm, ${addressNorm}) >= ${FUZZY_THRESHOLD}
      ORDER BY similarity DESC
      LIMIT 5
    `);

    for (const candidate of candidates) {
      /*
       * Spec §4.3 allows two confirming attributes: a centroid within 50m, or a matching owner
       * name. Only the centroid is implemented, because no current source supplies an owner
       * name — SDAT parcel points has no owner-name field at all (all 114 checked), and VBN has
       * none either. The owner-name branch is deliberately NOT stubbed in: an unreachable
       * code path cannot be tested, and one that silently never fires is worse than an absent
       * one that is documented. Add it together with the source that makes it testable.
       */
      if (candidate.centroid_confirms === true) {
        return { created: false, propertyId: candidate.id, via: 'fuzzy_confirmed' };
      }
      unconfirmedCandidate ??= candidate.id;
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
