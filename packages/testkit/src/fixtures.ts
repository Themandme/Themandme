import { createHash } from 'node:crypto';
import { markets, properties, sources, type Db } from '@magnolia/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

/** Fixtures for DB-backed tests. Kept minimal — real ingestion arrives in M2. */

/** The seeded Baltimore market. Throws if the seed has not run. */
export async function baltimoreMarketId(db: Db): Promise<string> {
  const [row] = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.key, 'baltimore_city_md'))
    .limit(1);
  if (row === undefined) throw new Error('fixture: seed() must run before creating properties');
  return row.id;
}

/** Look up a seeded source by key. */
export async function sourceIdByKey(db: Db, key: string): Promise<string> {
  const [row] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.key, key))
    .limit(1);
  if (row === undefined) throw new Error(`fixture: no seeded source "${key}"`);
  return row.id;
}

/**
 * Insert a property. `addressNorm` doubles as the uniqueness key, so callers pass a distinct
 * label per property; `address_hash` is derived the same way spec §4.3 specifies.
 */
export async function createProperty(db: Db, label: string): Promise<string> {
  const marketId = await baltimoreMarketId(db);
  const id = uuidv7();
  const addressNorm = label.toUpperCase();

  await db.insert(properties).values({
    id,
    marketId,
    addressLine1: label,
    city: 'BALTIMORE',
    stateCode: 'MD',
    postalCode: '21218',
    addressNorm,
    addressHash: createHash('sha256').update(`${addressNorm}21218`).digest(),
  });

  return id;
}
