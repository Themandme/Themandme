import { events, properties, seed, type Db } from '@magnolia/db';
import { baltimoreMarketId, createTestDb, type TestDb } from '@magnolia/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveProperty } from '../resolve-property.js';
import type { PropertyRef } from '../types.js';

/** Property entity resolution. Spec §4.3. */

let harness: TestDb | undefined;
let db: Db;
let marketId: string;

function ref(overrides: Partial<PropertyRef> = {}): PropertyRef {
  return {
    apn: null,
    blocklot: null,
    addressLine1: '2831 Guilford Ave',
    addressLine2: null,
    city: 'BALTIMORE',
    stateCode: 'MD',
    postalCode: '21218',
    centroid: null,
    ownerName: null,
    ...overrides,
  };
}

beforeAll(async () => {
  harness = await createTestDb('resolution');
  db = harness.db;
  await seed(db);
  marketId = await baltimoreMarketId(db);
}, 60_000);

afterAll(async () => {
  if (harness !== undefined) await harness.drop();
});

beforeEach(async () => {
  await db.delete(events);
  await db.delete(properties);
});

describe('tier 1 — APN', () => {
  it('matches an existing property on market + apn', async () => {
    const first = await resolveProperty(db, ref({ apn: '0301011738 004' }), { marketId });
    expect(first.created).toBe(true);

    /* Different address text, same APN — the APN is authoritative and must win before the
       address is even considered. */
    const second = await resolveProperty(
      db,
      ref({ apn: '0301011738 004', addressLine1: '2107 E Baltimore St' }),
      { marketId },
    );
    expect(second.created).toBe(false);
    if (second.created) return;
    expect(second.via).toBe('apn');
    expect(second.propertyId).toBe(first.propertyId);
  });
});

describe('tier 2 — exact normalized address', () => {
  it('matches formatting variants of the same address', async () => {
    const first = await resolveProperty(db, ref({ addressLine1: '2831 Guilford Ave' }), {
      marketId,
    });
    const second = await resolveProperty(db, ref({ addressLine1: '2831  guilford   avenue.' }), {
      marketId,
    });

    expect(second.created).toBe(false);
    if (second.created) return;
    expect(second.via).toBe('address_hash');
    expect(second.propertyId).toBe(first.propertyId);
    expect(await db.select().from(properties)).toHaveLength(1);
  });

  it('keeps a half-number apart from the whole number', async () => {
    /* The case the address normalizer exists for. 1234 and 1234 1/2 are different houses;
       merging them would attribute one owner's distress to the other's property. */
    await resolveProperty(db, ref({ addressLine1: '1234 N Charles St' }), { marketId });
    const half = await resolveProperty(db, ref({ addressLine1: '1234 1/2 N Charles St' }), {
      marketId,
    });

    expect(half.created).toBe(true);
    expect(await db.select().from(properties)).toHaveLength(2);
  });
});

describe('tier 3 — fuzzy plus a confirming attribute', () => {
  /*
   * What actually reaches this tier is narrower than it looks. `address_hash` is
   * sha256(address_norm || postal_code), so the realistic tier-3 case is the SAME normalized
   * address with a different or missing ZIP — one source carries a postal code, another does
   * not. The hash differs; the trigram similarity is 1.0.
   *
   * Measured against pg_trgm at the spec's 0.92 threshold, almost nothing else qualifies:
   *   "…AVE" vs "…AVE APT 2"        0.818   (rejected)
   *   "2831 …" vs "2833 …"          0.800   (rejected — correctly, different houses)
   *   "2831 N GUILFORD" vs "2831 GUILFORD"  0.900   (rejected)
   * With normalization running first, anything scoring above 0.92 has usually already matched
   * at tier 2. That is a safe direction to err in — a missed match creates a duplicate for
   * review, a wrong match silently merges two houses — but it means the fuzzy tier is a
   * narrow backstop rather than a broad net.
   */

  it('matches on a ZIP difference when a centroid confirms it', async () => {
    const first = await resolveProperty(
      db,
      ref({
        addressLine1: '2831 GUILFORD AVE',
        postalCode: '21218',
        centroid: [-76.6149, 39.3213],
      }),
      { marketId },
    );

    /* Same address, no ZIP — different hash, similarity 1.0 — and ~10m away, so confirmed. */
    const second = await resolveProperty(
      db,
      ref({ addressLine1: '2831 GUILFORD AVE', postalCode: null, centroid: [-76.61489, 39.32131] }),
      { marketId },
    );

    expect(second.created).toBe(false);
    if (second.created) return;
    expect(second.via).toBe('fuzzy_confirmed');
    expect(second.propertyId).toBe(first.propertyId);
  });

  it('does NOT merge on fuzzy alone — it creates and flags a possible duplicate', async () => {
    /* Spec §4.3: "Never auto-merge on fuzzy alone." Same similarity as the test above, but no
       centroid on either side, so nothing confirms it. Two rows and a human is told. */
    const first = await resolveProperty(
      db,
      ref({ addressLine1: '2831 GUILFORD AVE', postalCode: '21218' }),
      { marketId },
    );
    const second = await resolveProperty(
      db,
      ref({ addressLine1: '2831 GUILFORD AVE', postalCode: null }),
      { marketId },
    );

    expect(second.created).toBe(true);
    if (!second.created) return;
    expect(second.possibleDuplicateOf).toBe(first.propertyId);
    expect(await db.select().from(properties)).toHaveLength(2);
  });

  it('refuses to confirm on a centroid that is far away', async () => {
    /* Same address text, but ~1.5km apart. Similarity alone would merge them; the confirming
       attribute is what stops it. */
    await resolveProperty(
      db,
      ref({
        addressLine1: '2831 GUILFORD AVE',
        postalCode: '21218',
        centroid: [-76.6149, 39.3213],
      }),
      { marketId },
    );
    const far = await resolveProperty(
      db,
      ref({ addressLine1: '2831 GUILFORD AVE', postalCode: null, centroid: [-76.6149, 39.335] }),
      { marketId },
    );

    expect(far.created, 'a distant centroid must not confirm').toBe(true);
  });

  it('emits property.possible_duplicate for review', async () => {
    await resolveProperty(db, ref({ addressLine1: '2831 GUILFORD AVE', postalCode: '21218' }), {
      marketId,
    });
    await resolveProperty(db, ref({ addressLine1: '2831 GUILFORD AVE', postalCode: null }), {
      marketId,
    });

    const emitted = await db
      .select()
      .from(events)
      .where(eq(events.topic, 'property.possible_duplicate'));
    expect(emitted, 'a near-match with no confirmer must reach a human').toHaveLength(1);
  });

  it('leaves a different house number alone (0.80 — below threshold)', async () => {
    await resolveProperty(db, ref({ addressLine1: '2831 GUILFORD AVE' }), { marketId });
    const neighbour = await resolveProperty(db, ref({ addressLine1: '2833 GUILFORD AVE' }), {
      marketId,
    });
    expect(neighbour.created).toBe(true);
    if (!neighbour.created) return;
    expect(neighbour.possibleDuplicateOf, 'neighbours are not duplicates').toBeNull();
  });

  it('does not merge two genuinely different addresses', async () => {
    await resolveProperty(db, ref({ addressLine1: '100 N Charles St' }), { marketId });
    const other = await resolveProperty(db, ref({ addressLine1: '900 S Broadway' }), { marketId });
    expect(other.created).toBe(true);
    expect(await db.select().from(properties)).toHaveLength(2);
  });
});

describe('idempotency and races', () => {
  it('re-resolving the same ref creates nothing new', async () => {
    const input = ref({ apn: '0301011738 004' });
    const first = await resolveProperty(db, input, { marketId });
    const second = await resolveProperty(db, input, { marketId });
    const third = await resolveProperty(db, input, { marketId });

    expect(second.propertyId).toBe(first.propertyId);
    expect(third.propertyId).toBe(first.propertyId);
    expect(await db.select().from(properties)).toHaveLength(1);
  });

  it('concurrent resolution of one address yields exactly one property', async () => {
    /* The database arbitrates via properties_address_key, not the application. Without the
       unique-violation catch this races into two rows for one house. */
    const input = ref({ addressLine1: '77 Race Condition Way' });
    const results = await Promise.all([
      resolveProperty(db, input, { marketId }),
      resolveProperty(db, input, { marketId }),
      resolveProperty(db, input, { marketId }),
      resolveProperty(db, input, { marketId }),
    ]);

    const ids = new Set(results.map((r) => r.propertyId));
    expect(ids.size, 'all callers must agree on one property id').toBe(1);
    expect(await db.select().from(properties)).toHaveLength(1);
  });
});
