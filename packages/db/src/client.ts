import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/** A Drizzle client bound to the Magnolia schema. */
export type Db = ReturnType<typeof createDb>;

export function createDb(connectionString: string, options: { max?: number } = {}) {
  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    /* Money is integer cents and probabilities are numeric(5,4); the schema declares those
       columns with `mode: 'number'`, so postgres.js must not hand back strings. */
    types: {},
    onnotice: () => {
      /* Notices are noise outside migrations. */
    },
  });
  return drizzle(sql, { schema, casing: 'snake_case' });
}

/** Close the underlying pool. Tests and one-shot scripts need this to exit. */
export async function closeDb(db: Db): Promise<void> {
  await (db.$client as unknown as { end: () => Promise<void> }).end();
}
