import { facts, properties, sources } from '@magnolia/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { preferenceOrder, preferredFact } from '../facts/conflicts.js';
import type { PredicateRegistry } from '../facts/predicate-registry.js';
import type { DbOrTx } from '../facts/record-fact.js';

/**
 * Read-model projector. BUILD_PLAN M1.5, spec §4.1 rule 4.
 *
 * The scalar columns on `properties` are a read model recomputed from current facts. This is
 * the ONLY writer of them — invariant 1. Nothing else may set `year_built` and friends, which
 * is what stops "the address says vacant but the read model says occupied" from becoming an
 * unresolvable mystery.
 *
 * Idempotent and order-independent: projecting twice produces the same row, and projecting
 * after an arbitrary sequence of fact writes produces the same row as projecting from scratch.
 * The property-based test in `__tests__` is what holds this honest.
 */

/**
 * Columns the projector is permitted to write, with the coercion each needs.
 *
 * An allowlist rather than free-form config: `read_model_column` comes from a YAML file and is
 * interpolated into an UPDATE, so a typo should fail loudly at projection time rather than
 * either silently doing nothing or naming a column that is not part of the read model. This
 * also documents, in one place, exactly which columns are derived.
 */
interface ProjectableColumn {
  nullable: boolean;
  fallback?: unknown;
  /**
   * The Postgres type, used to cast the batched UPDATE's `VALUES` list.
   *
   * Required, not inferred. A `VALUES` row of all-NULLs types itself as `text`, and the UPDATE
   * then fails on the first integer column — so the cast has to be explicit, and it has to live
   * next to the nullability it belongs with rather than in a second list that can drift.
   */
  pgType: string;
}

const PROJECTABLE: Record<string, ProjectableColumn> = {
  property_type: { nullable: true, pgType: 'text' },
  year_built: { nullable: true, pgType: 'integer' },
  building_sqft: { nullable: true, pgType: 'integer' },
  lot_sqft: { nullable: true, pgType: 'integer' },
  beds: { nullable: true, pgType: 'numeric(4,1)' },
  baths: { nullable: true, pgType: 'numeric(4,1)' },
  zoning_code: { nullable: true, pgType: 'text' },
  last_sale_date: { nullable: true, pgType: 'date' },
  last_sale_price_cents: { nullable: true, pgType: 'bigint' },
  assessed_value_cents: { nullable: true, pgType: 'bigint' },
  /* NOT NULL with a default in schema.sql, so an absent fact means false, not null. */
  is_vacant_land: { nullable: false, fallback: false, pgType: 'boolean' },
};

export class UnprojectableColumnError extends Error {
  constructor(column: string, predicate: string) {
    super(
      `predicate "${predicate}" declares read_model_column "${column}", which is not a ` +
        `projectable column. Allowed: ${Object.keys(PROJECTABLE).join(', ')}. ` +
        `Check config/predicates/v1.yaml.`,
    );
    this.name = 'UnprojectableColumnError';
  }
}

export interface ProjectionResult {
  propertyId: string;
  /** Column -> value written. Useful in tests and for the deal-replay view. */
  columns: Record<string, unknown>;
}

/** Compute the read-model values for a property without writing them. */
export async function computeProjection(
  tx: DbOrTx,
  registry: PredicateRegistry,
  propertyId: string,
): Promise<Record<string, unknown>> {
  const columns: Record<string, unknown> = {};

  /* Sorted so the computed object has a stable key order — it is compared directly in tests
     and rendered in replay. */
  const projecting = [...registry.projecting()].sort((a, b) => (a.key < b.key ? -1 : 1));

  for (const definition of projecting) {
    const column = definition.readModelColumn;
    if (column === null) continue;

    const meta = PROJECTABLE[column];
    if (meta === undefined) throw new UnprojectableColumnError(column, definition.key);

    /* preferredFact applies the §4.2 hierarchy. It does not resolve or suppress a conflict —
       detection still records the disagreement; this decides only what the read model shows
       while the conflict is open. */
    const preferred = await preferredFact(tx, 'property', propertyId, definition.key);

    if (preferred === undefined) {
      columns[column] = meta.nullable ? null : (meta.fallback ?? null);
    } else {
      columns[column] = preferred.value;
    }
  }

  return columns;
}

/**
 * Recompute and persist the read model for one property.
 *
 * Safe to call repeatedly; safe to call after any sequence of fact writes.
 */
export async function projectProperty(
  tx: DbOrTx,
  registry: PredicateRegistry,
  propertyId: string,
): Promise<ProjectionResult> {
  const columns = await computeProjection(tx, registry, propertyId);

  const assignments = Object.entries(columns).map(
    ([column, value]) => sql`${sql.identifier(column)} = ${value}`,
  );

  await tx.execute(sql`
    UPDATE ${properties}
    SET ${sql.join(assignments, sql`, `)}, read_model_at = now(), updated_at = now()
    WHERE id = ${propertyId}
  `);

  return { propertyId, columns };
}

/* ── Batched projection ──────────────────────────────────────────────────────────────────
 *
 * `projectProperty` costs one query per projectable column plus one UPDATE — about twelve round
 * trips per property. Measured on a real VBN load: 11,513 properties took roughly 138,000
 * queries and most of a five-minute job. SDAT's 222,703 Baltimore parcels would be ~2.7 million,
 * which is not a slow operation so much as an impossible one.
 *
 * The batched path collapses that to **two queries per chunk**, regardless of chunk size: one
 * SELECT for every current fact across every property in the chunk, and one UPDATE.
 *
 * The per-property function is kept rather than replaced. It is the readable definition of what
 * projection *means*, the property test's reference implementation, and the right tool when a
 * single property is touched. `projectionsAgree` below asserts the two agree.
 */

/**
 * How many properties are folded into one round trip.
 *
 * Bounded by Postgres's 65,535 bind parameters: the UPDATE binds one id plus eleven columns per
 * property, so 500 uses ~6,000 — comfortable, while still cutting round trips by three orders of
 * magnitude. Larger chunks buy little and make a single failed statement more expensive to retry.
 */
export const PROJECTION_CHUNK_SIZE = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * Compute read-model values for many properties with a single query.
 *
 * Returns a map keyed by property id. Every requested id is present, including ones with no
 * facts at all — those get the same defaults `computeProjection` would produce, because "no
 * facts" must clear a stale column rather than leave it standing.
 */
export async function computeProjections(
  tx: DbOrTx,
  registry: PredicateRegistry,
  propertyIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const projecting = [...registry.projecting()]
    .filter((definition) => definition.readModelColumn !== null)
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  for (const definition of projecting) {
    const column = definition.readModelColumn;
    if (column !== null && PROJECTABLE[column] === undefined) {
      throw new UnprojectableColumnError(column, definition.key);
    }
  }

  /* Defaults first, so a property with no facts still gets a complete row. */
  const result = new Map<string, Record<string, unknown>>();
  const empty: Record<string, unknown> = {};
  for (const definition of projecting) {
    const column = definition.readModelColumn;
    if (column === null) continue;
    const meta = PROJECTABLE[column];
    if (meta === undefined) continue;
    empty[column] = meta.nullable ? null : (meta.fallback ?? null);
  }
  for (const id of propertyIds) result.set(id, { ...empty });

  if (propertyIds.length === 0 || projecting.length === 0) return result;

  /* ONE query for the whole chunk. The tier join is what `preferredFact` does per call; doing it
     once for every (property, predicate) pair is the entire saving. */
  const rows = await tx
    .select({
      id: facts.id,
      subjectId: facts.subjectId,
      predicate: facts.predicate,
      value: facts.value,
      observedAt: facts.observedAt,
      tier: sources.tier,
    })
    .from(facts)
    .innerJoin(sources, eq(facts.sourceId, sources.id))
    .where(
      and(
        eq(facts.subjectType, 'property'),
        inArray(facts.subjectId, [...propertyIds]),
        inArray(
          facts.predicate,
          projecting.map((definition) => definition.key),
        ),
        eq(facts.isCurrent, true),
      ),
    );

  const columnFor = new Map(
    projecting.map((definition) => [definition.key, definition.readModelColumn]),
  );

  /* Group, then pick the winner with the SAME comparator `preferredFact` uses — see
     `preferenceOrder`. Reimplementing the order here would let a batched projection silently
     disagree with a single one. */
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.subjectId}|${row.predicate}`;
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [row]);
    else bucket.push(row);
  }

  for (const bucket of grouped.values()) {
    const winner = [...bucket].sort(preferenceOrder)[0];
    if (winner === undefined) continue;
    const column = columnFor.get(winner.predicate);
    if (column === undefined || column === null) continue;
    /* Read the id off the row rather than parsing it back out of the grouping key — the key
       is an implementation detail of the grouping, not an identifier. */
    const target = result.get(winner.subjectId);
    if (target !== undefined) target[column] = winner.value;
  }

  return result;
}

/**
 * Recompute and persist the read model for many properties.
 *
 * Two queries per chunk instead of twelve per property. Order-independent and idempotent, the
 * same as the single-property path.
 */
export async function projectProperties(
  tx: DbOrTx,
  registry: PredicateRegistry,
  propertyIds: readonly string[],
): Promise<{ projected: number }> {
  if (propertyIds.length === 0) return { projected: 0 };

  /* De-duplicate: the ingestion pipeline collects touched ids in a Set, but a caller passing an
     array with repeats would otherwise put the same id twice in one VALUES list, which Postgres
     accepts and which makes the UPDATE's result order-dependent. */
  const unique = [...new Set(propertyIds)];
  let projected = 0;

  for (const batch of chunk(unique, PROJECTION_CHUNK_SIZE)) {
    const computed = await computeProjections(tx, registry, batch);
    const columns = Object.keys(PROJECTABLE).filter((column) =>
      [...computed.values()].some((values) => column in values),
    );
    if (columns.length === 0) return { projected: 0 };

    /*
     * `UPDATE … FROM (VALUES …)` — one statement for the whole chunk.
     *
     * Every value carries its cast, on every row rather than only the first. Postgres infers a
     * VALUES column's type from the first row, so a chunk whose first property happens to have a
     * NULL year_built would type that column as `text` and then fail on the next row that has an
     * integer. Casting uniformly costs nothing and removes the ordering dependency entirely.
     */
    const tuples = batch.map((id) => {
      const values = computed.get(id) ?? {};
      const cells = columns.map((column) => {
        const pgType = PROJECTABLE[column]?.pgType ?? 'text';
        return sql`${values[column] ?? null}::${sql.raw(pgType)}`;
      });
      return sql`(${sql.join([sql`${id}::uuid`, ...cells], sql`, `)})`;
    });

    const assignments = columns.map(
      (column) => sql`${sql.identifier(column)} = v.${sql.identifier(column)}`,
    );
    const columnNames = sql.join(
      columns.map((column) => sql.identifier(column)),
      sql`, `,
    );

    await tx.execute(sql`
      UPDATE ${properties} AS p
      SET ${sql.join(assignments, sql`, `)}, read_model_at = now(), updated_at = now()
      FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, ${columnNames})
      WHERE p.id = v.id
    `);

    projected += batch.length;
  }

  return { projected };
}

/**
 * Recompute every property's read model from scratch.
 *
 * BUILD_PLAN M1.5 requires this be re-runnable: it is the repair path when a projection is
 * suspected wrong, and the reference the property-based test compares incremental maintenance
 * against.
 */
export async function projectAll(
  tx: DbOrTx,
  registry: PredicateRegistry,
): Promise<{ projected: number }> {
  const rows = await tx.select({ id: properties.id }).from(properties);
  return projectProperties(
    tx,
    registry,
    rows.map((row) => row.id),
  );
}

/** The columns this projector owns. Exported so tests can assert nothing else writes them. */
export function projectableColumns(): readonly string[] {
  return Object.keys(PROJECTABLE);
}
