import { events, markets, properties, seed, type Db } from '@magnolia/db';
import { baltimoreMarketId, createTestDb, type TestDb } from '@magnolia/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadResolutionParams, type ResolutionParams } from '../market-params.js';
import { resolveProperties, resolveProperty, type ResolveOptions } from '../resolve-property.js';
import type { PropertyRef } from '../types.js';

/** Property entity resolution. Spec §4.3 as amended — see packages/db/DIVERGENCES.md. */

let harness: TestDb | undefined;
let db: Db;
let marketId: string;
let params: ResolutionParams;

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

/** The seeded market's own parameters, so the tests exercise the shipped configuration. */
function opts(overrides: Partial<ResolveOptions> = {}): ResolveOptions {
  return { marketId, ...params, ...overrides };
}

/*
 * Baltimore is at ~39.32 N, where 0.00001 degrees of latitude is about 1.11 m. The offsets below
 * are written in those terms rather than as opaque decimals, because the distances are the point
 * of several of these tests.
 */
const BASE: [number, number] = [-76.6149, 39.3213];
const METRES_PER_DEG_LAT = 111_320;
function metresNorth(from: [number, number], metres: number): [number, number] {
  return [from[0], from[1] + metres / METRES_PER_DEG_LAT];
}

beforeAll(async () => {
  harness = await createTestDb('resolution');
  db = harness.db;
  await seed(db);
  marketId = await baltimoreMarketId(db);
  params = await loadResolutionParams(db, marketId);
}, 60_000);

afterAll(async () => {
  if (harness !== undefined) await harness.drop();
});

beforeEach(async () => {
  await db.delete(events);
  await db.delete(properties);
});

describe('parameters come from the market row', () => {
  it('reads the seeded configuration', () => {
    /* Not asserting the literal values — those live in config/markets/baltimore.yaml and are
       expected to be tuned. Asserting they are present and in range is what matters here. */
    expect(params.fuzzyThreshold).toBeGreaterThan(0);
    expect(params.fuzzyThreshold).toBeLessThanOrEqual(1);
    expect(params.centroidConfirmMetres).toBeGreaterThan(0);
  });

  it('throws rather than falling back when the market config lacks them', async () => {
    /* CLAUDE.md: market parameters live in config/, never in code. A code-level default would
       mean an operator could edit the YAML, re-seed, and silently get the old behaviour. */
    await db
      .update(markets)
      .set({ config: { aging_days: 14 } })
      .where(eq(markets.id, marketId));
    await expect(loadResolutionParams(db, marketId)).rejects.toThrow(/fuzzy_address_threshold/);

    /* Restore — the other suites in this file depend on the seeded values. */
    await seed(db);
  });
});

describe('tier 1 — APN', () => {
  it('matches an existing property on market + apn', async () => {
    const first = await resolveProperty(db, ref({ apn: '0301011738 004' }), opts());
    expect(first.created).toBe(true);

    /* Different address text, same APN — the APN is authoritative and must win before the
       address is even considered. */
    const second = await resolveProperty(
      db,
      ref({ apn: '0301011738 004', addressLine1: '2107 E Baltimore St' }),
      opts(),
    );
    expect(second.created).toBe(false);
    if (second.created) return;
    expect(second.via).toBe('apn');
    expect(second.propertyId).toBe(first.propertyId);
  });
});

describe('tier 2 — exact normalized address', () => {
  it('matches formatting variants of the same address', async () => {
    const first = await resolveProperty(db, ref({ addressLine1: '2831 Guilford Ave' }), opts());
    const second = await resolveProperty(
      db,
      ref({ addressLine1: '2831  guilford   avenue.' }),
      opts(),
    );

    expect(second.created).toBe(false);
    if (second.created) return;
    expect(second.via).toBe('address_hash');
    expect(second.propertyId).toBe(first.propertyId);
    expect(await db.select().from(properties)).toHaveLength(1);
  });
});

describe('an unparseable address is not an identity', () => {
  /*
   * Found by auditing the loaded Baltimore market, not by reading the spec.
   *
   * §4.3 defines `address_hash = sha256(address_norm || postal_code)`. When the address
   * normalizes to nothing that degenerates to `sha256('' || zip)` — **identical for every
   * address-less parcel in the same ZIP** — and tier 2 then merges them all into one property.
   *
   * Measured on the live SDAT load: 4,444 distinct parcels collapsed into 31 property rows, one
   * per ZIP, the worst holding 591. Their owner facts thrash, because each parcel's owner
   * supersedes the previous one and "current owner" becomes whichever parcel was normalized
   * last.
   *
   * This is the failure tier 3 already refuses by name — "a duplicate that reaches a human is
   * recoverable, a silent merge is not" — arriving through tier 2, which had no such guard.
   */
  it('does not merge two address-less parcels that share a ZIP', async () => {
    const a = await resolveProperty(
      db,
      ref({ apn: 'ACCT-A', addressLine1: '', postalCode: '21215' }),
      opts(),
    );
    const b = await resolveProperty(
      db,
      ref({ apn: 'ACCT-B', addressLine1: '', postalCode: '21215' }),
      opts(),
    );

    expect(b.created).toBe(true);
    expect(b.propertyId).not.toBe(a.propertyId);
    expect(await db.select().from(properties)).toHaveLength(2);
  });

  it('still resolves an address-less parcel to itself by APN', async () => {
    /* Splitting them must not cost idempotency (invariant 7): the same parcel seen twice is
       still one property. */
    const first = await resolveProperty(
      db,
      ref({ apn: 'ACCT-A', addressLine1: '', postalCode: '21215' }),
      opts(),
    );
    const again = await resolveProperty(
      db,
      ref({ apn: 'ACCT-A', addressLine1: '', postalCode: '21215' }),
      opts(),
    );

    expect(again.created).toBe(false);
    if (again.created) return;
    expect(again.via).toBe('apn');
    expect(again.propertyId).toBe(first.propertyId);
    expect(await db.select().from(properties)).toHaveLength(1);
  });

  it('does not let an address-less parcel collide with a real address', async () => {
    /* The APN-derived hash occupies the same NOT NULL UNIQUE column as a real address hash, so
       it must live in a space a genuine address can never reach. */
    const real = await resolveProperty(
      db,
      ref({ apn: 'ACCT-REAL', addressLine1: '2831 Guilford Ave', postalCode: '21218' }),
      opts(),
    );
    const blank = await resolveProperty(
      db,
      ref({ apn: 'ACCT-BLANK', addressLine1: '', postalCode: '21218' }),
      opts(),
    );

    expect(blank.propertyId).not.toBe(real.propertyId);
    expect(await db.select().from(properties)).toHaveLength(2);
  });

  it('enforces the same rule in the batched path', async () => {
    /*
     * The batched path is what ingestion actually calls, so a rule enforced only in
     * `resolveProperty` would be enforced nowhere that matters — and this is precisely how the
     * production merge happened. Same principle as `recordFacts`: the batched door must not be
     * weaker than the single one.
     */
    const result = await resolveProperties(
      db,
      [
        ref({ apn: 'ACCT-A', addressLine1: '', postalCode: '21215' }),
        ref({ apn: 'ACCT-B', addressLine1: '', postalCode: '21215' }),
        ref({ apn: 'ACCT-C', addressLine1: '', postalCode: '21215' }),
      ],
      opts(),
    );

    const ids = new Set([...result.byIndex.values()]);
    expect(ids.size).toBe(3);
    expect(await db.select().from(properties)).toHaveLength(3);
  });

  it('batched and single-reference paths agree', async () => {
    /* A silent disagreement between them means a parcel resolved in a chunk lands on a different
       row from the same parcel resolved alone — which is a merge that only appears under load. */
    const single = await resolveProperty(
      db,
      ref({ apn: 'ACCT-A', addressLine1: '', postalCode: '21215' }),
      opts(),
    );
    const batched = await resolveProperties(
      db,
      [ref({ apn: 'ACCT-A', addressLine1: '', postalCode: '21215' })],
      opts(),
    );
    expect(batched.byIndex.get(0)).toBe(single.propertyId);
    expect(await db.select().from(properties)).toHaveLength(1);
  });

  it('treats punctuation-only text as no address rather than as an address', async () => {
    /* `address_norm` is empty either way; what matters is that the resolver keys off the parsed
       result, not off whether the raw input happened to be non-empty. */
    const a = await resolveProperty(
      db,
      ref({ apn: 'ACCT-A', addressLine1: '...', postalCode: '21215' }),
      opts(),
    );
    const b = await resolveProperty(
      db,
      ref({ apn: 'ACCT-B', addressLine1: '', postalCode: '21215' }),
      opts(),
    );
    expect(b.propertyId).not.toBe(a.propertyId);
  });
});

/*
 * The merge-safety cases.
 *
 * These are the reason tier 3 was restructured. Each pair is one that trigram similarity scores
 * high enough to be dangerous, and each must produce TWO properties. A merge here silently
 * attributes one owner's distress to another's house, and unlike a duplicate it is not
 * recoverable — nothing downstream can tell that the two were ever separate.
 *
 * Every one of them is given a CONFIRMING centroid, so the only thing standing between the two
 * records is the structural gate. If that gate is removed these tests fail.
 */
describe('merge safety — structurally different dwellings never merge', () => {
  it('does NOT merge adjacent rowhouses 4 m apart (2831 vs 2833)', async () => {
    /* The case the design has to get right. Measured on live SDAT: adjacent Baltimore rowhouses
       sit 4.4-5.5 m apart, and 2831/2833 score 0.800 on the full address. Similarity says
       "probably", the 50 m radius says "yes" — and both are wrong. Only the exact house-number
       match keeps them apart. */
    const first = await resolveProperty(
      db,
      ref({ addressLine1: '2831 GUILFORD AVE', postalCode: '21218', centroid: BASE }),
      opts(),
    );
    const neighbour = await resolveProperty(
      db,
      ref({
        addressLine1: '2833 GUILFORD AVE',
        postalCode: null,
        centroid: metresNorth(BASE, 4),
      }),
      opts(),
    );

    expect(neighbour.created, 'adjacent rowhouses must never merge').toBe(true);
    if (!neighbour.created) return;
    expect(neighbour.possibleDuplicateOf, 'neighbours are not duplicates').toBeNull();
    expect(neighbour.propertyId).not.toBe(first.propertyId);
    expect(await db.select().from(properties)).toHaveLength(2);
  });

  it('does NOT merge a half-number with the whole number', async () => {
    /* The case the address normalizer exists for. 1234 and 1234 1/2 are different houses. */
    await resolveProperty(db, ref({ addressLine1: '1234 N Charles St', centroid: BASE }), opts());
    const half = await resolveProperty(
      db,
      ref({
        addressLine1: '1234 1/2 N Charles St',
        postalCode: null,
        centroid: metresNorth(BASE, 3),
      }),
      opts(),
    );

    expect(half.created).toBe(true);
    expect(await db.select().from(properties)).toHaveLength(2);
  });

  it('does NOT merge a rear dwelling with the front one', async () => {
    /* "1900 Bolton St Rear" is a separate dwelling sharing a lot — so the centroids genuinely
       are metres apart, and the radius genuinely does confirm. The unit is what separates them. */
    await resolveProperty(db, ref({ addressLine1: '1900 Bolton St', centroid: BASE }), opts());
    const rear = await resolveProperty(
      db,
      ref({
        addressLine1: '1900 Bolton St Rear',
        postalCode: null,
        centroid: metresNorth(BASE, 8),
      }),
      opts(),
    );

    expect(rear.created).toBe(true);
    expect(await db.select().from(properties)).toHaveLength(2);
  });

  it('does NOT merge opposing directionals (N vs S Charles St)', async () => {
    /* Baltimore numbers north and south from Baltimore St, so 100 N Charles and 100 S Charles
       both exist and are different buildings. Trigram scores this pair at 0.786 — HIGHER than a
       genuine typo — so no threshold could reject it. The structural gate does. Given a
       confirming centroid, this test isolates that gate completely. */
    const north = await resolveProperty(
      db,
      ref({ addressLine1: '100 N Charles St', centroid: BASE }),
      opts(),
    );
    const south = await resolveProperty(
      db,
      ref({ addressLine1: '100 S Charles St', postalCode: null, centroid: metresNorth(BASE, 5) }),
      opts(),
    );

    expect(south.created, 'N and S of a divided street are different buildings').toBe(true);
    if (!south.created) return;
    expect(south.propertyId).not.toBe(north.propertyId);
  });

  it('does NOT merge differing suffixes (GUILFORD AVE vs GUILFORD ST)', async () => {
    await resolveProperty(db, ref({ addressLine1: '2831 Guilford Ave', centroid: BASE }), opts());
    const other = await resolveProperty(
      db,
      ref({ addressLine1: '2831 Guilford St', postalCode: null, centroid: metresNorth(BASE, 5) }),
      opts(),
    );
    expect(other.created).toBe(true);
    expect(await db.select().from(properties)).toHaveLength(2);
  });

  it('does NOT merge different streets at the same number, even at high similarity', async () => {
    /* LOMBARD vs LOMBARDY scores 0.700 — above every genuine typo in the measured set. The
       centroid is what rejects it, and it can, because different streets are far apart. */
    await resolveProperty(db, ref({ addressLine1: '400 Lombard St', centroid: BASE }), opts());
    const other = await resolveProperty(
      db,
      ref({
        addressLine1: '400 Lombardy St',
        postalCode: null,
        centroid: metresNorth(BASE, 900),
      }),
      opts(),
    );
    expect(other.created).toBe(true);
    expect(await db.select().from(properties)).toHaveLength(2);
  });
});

describe('tier 3 — same dwelling plus a confirming attribute', () => {
  it('matches on a ZIP difference when a centroid confirms it', async () => {
    /* The realistic tier-3 case: `address_hash` is sha256(address_norm || postal_code), so one
       source carrying a ZIP and another not produces different hashes for identical text. */
    const first = await resolveProperty(
      db,
      ref({ addressLine1: '2831 GUILFORD AVE', postalCode: '21218', centroid: BASE }),
      opts(),
    );
    const second = await resolveProperty(
      db,
      ref({
        addressLine1: '2831 GUILFORD AVE',
        postalCode: null,
        centroid: metresNorth(BASE, 10),
      }),
      opts(),
    );

    expect(second.created).toBe(false);
    if (second.created) return;
    expect(second.via).toBe('fuzzy_confirmed');
    expect(second.propertyId).toBe(first.propertyId);
  });

  it('matches through a street-name typo when the centroid confirms', async () => {
    /* GUILFORD/GUILFRD scores 0.545 on the street name — below several pairs that must NOT
       match, which is why the score cannot decide. The centroid decides; the score only has to
       be low enough to let the row be considered. */
    const first = await resolveProperty(
      db,
      ref({ addressLine1: '2831 Guilford Ave', centroid: BASE }),
      opts(),
    );
    const typo = await resolveProperty(
      db,
      ref({ addressLine1: '2831 Guilfrd Ave', postalCode: null, centroid: metresNorth(BASE, 6) }),
      opts(),
    );

    expect(typo.created).toBe(false);
    if (typo.created) return;
    expect(typo.propertyId).toBe(first.propertyId);
  });

  it('matches through a dropped directional when the centroid confirms', async () => {
    /* A missing directional is missing DATA, not a different street — so it is compatible
       rather than equal. The centroid resolves the ambiguity it leaves behind. */
    const first = await resolveProperty(
      db,
      ref({ addressLine1: '2831 N Guilford Ave', centroid: BASE }),
      opts(),
    );
    const dropped = await resolveProperty(
      db,
      ref({ addressLine1: '2831 Guilford Ave', postalCode: null, centroid: metresNorth(BASE, 6) }),
      opts(),
    );

    expect(dropped.created).toBe(false);
    if (dropped.created) return;
    expect(dropped.propertyId).toBe(first.propertyId);
  });

  it('does NOT merge on similarity alone — it creates and flags a possible duplicate', async () => {
    /* Spec §4.3: "Never auto-merge on fuzzy alone." Identical text, no centroid on either side,
       so nothing confirms it. Two rows, and a human is told. */
    const first = await resolveProperty(
      db,
      ref({ addressLine1: '2831 GUILFORD AVE', postalCode: '21218' }),
      opts(),
    );
    const second = await resolveProperty(
      db,
      ref({ addressLine1: '2831 GUILFORD AVE', postalCode: null }),
      opts(),
    );

    expect(second.created).toBe(true);
    if (!second.created) return;
    expect(second.possibleDuplicateOf).toBe(first.propertyId);
    expect(await db.select().from(properties)).toHaveLength(2);
  });

  it('refuses to confirm on a centroid that is far away', async () => {
    await resolveProperty(
      db,
      ref({ addressLine1: '2831 GUILFORD AVE', postalCode: '21218', centroid: BASE }),
      opts(),
    );
    const far = await resolveProperty(
      db,
      ref({
        addressLine1: '2831 GUILFORD AVE',
        postalCode: null,
        centroid: metresNorth(BASE, 1500),
      }),
      opts(),
    );

    expect(far.created, 'a distant centroid must not confirm').toBe(true);
  });

  it('emits property.possible_duplicate for review', async () => {
    await resolveProperty(
      db,
      ref({ addressLine1: '2831 GUILFORD AVE', postalCode: '21218' }),
      opts(),
    );
    await resolveProperty(db, ref({ addressLine1: '2831 GUILFORD AVE', postalCode: null }), opts());

    const emitted = await db
      .select()
      .from(events)
      .where(eq(events.topic, 'property.possible_duplicate'));
    expect(emitted, 'a near-match with no confirmer must reach a human').toHaveLength(1);
  });

  it('skips the tier entirely when there is no parseable house number', async () => {
    /* With nothing to pin, the remaining text is a street — which would match every property on
       it. Two records naming only "GUILFORD AVE" must stay separate and unflagged. */
    await resolveProperty(db, ref({ addressLine1: 'Guilford Ave', centroid: BASE }), opts());
    const second = await resolveProperty(
      db,
      ref({ addressLine1: 'Guilford Avenue', postalCode: null, centroid: metresNorth(BASE, 2) }),
      opts(),
    );

    expect(second.created).toBe(true);
    if (!second.created) return;
    expect(second.possibleDuplicateOf, 'tier 3 must not run at all').toBeNull();
  });

  it('reads the threshold from options rather than a constant', async () => {
    /* Proves the value is genuinely wired. The typo case above matches at the seeded recall
       floor; raising the floor above the pair's street similarity (0.545) excludes the candidate
       before it can be confirmed, so the same inputs produce a different outcome. */
    await resolveProperty(db, ref({ addressLine1: '2831 Guilford Ave', centroid: BASE }), opts());
    const strict = await resolveProperty(
      db,
      ref({ addressLine1: '2831 Guilfrd Ave', postalCode: null, centroid: metresNorth(BASE, 6) }),
      opts({ fuzzyThreshold: 0.95 }),
    );

    expect(strict.created, 'a stricter recall floor must change the outcome').toBe(true);
  });

  it('does not merge two genuinely different addresses', async () => {
    await resolveProperty(db, ref({ addressLine1: '100 N Charles St' }), opts());
    const other = await resolveProperty(db, ref({ addressLine1: '900 S Broadway' }), opts());
    expect(other.created).toBe(true);
    expect(await db.select().from(properties)).toHaveLength(2);
  });
});

describe('idempotency and races', () => {
  it('re-resolving the same ref creates nothing new', async () => {
    const input = ref({ apn: '0301011738 004' });
    const first = await resolveProperty(db, input, opts());
    const second = await resolveProperty(db, input, opts());
    const third = await resolveProperty(db, input, opts());

    expect(second.propertyId).toBe(first.propertyId);
    expect(third.propertyId).toBe(first.propertyId);
    expect(await db.select().from(properties)).toHaveLength(1);
  });

  it('concurrent resolution of one address yields exactly one property', async () => {
    /* The database arbitrates via properties_address_key, not the application. Without the
       unique-violation catch this races into two rows for one house. */
    const input = ref({ addressLine1: '77 Race Condition Way' });
    const results = await Promise.all([
      resolveProperty(db, input, opts()),
      resolveProperty(db, input, opts()),
      resolveProperty(db, input, opts()),
      resolveProperty(db, input, opts()),
    ]);

    const ids = new Set(results.map((r) => r.propertyId));
    expect(ids.size, 'all callers must agree on one property id').toBe(1);
    expect(await db.select().from(properties)).toHaveLength(1);
  });
});
