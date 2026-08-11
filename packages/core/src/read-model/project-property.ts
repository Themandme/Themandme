import { properties } from '@magnolia/db';
import { sql } from 'drizzle-orm';
import { preferredFact } from '../facts/conflicts.js';
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
const PROJECTABLE: Record<string, { nullable: boolean; fallback?: unknown }> = {
  property_type: { nullable: true },
  year_built: { nullable: true },
  building_sqft: { nullable: true },
  lot_sqft: { nullable: true },
  beds: { nullable: true },
  baths: { nullable: true },
  zoning_code: { nullable: true },
  last_sale_date: { nullable: true },
  last_sale_price_cents: { nullable: true },
  assessed_value_cents: { nullable: true },
  /* NOT NULL with a default in schema.sql, so an absent fact means false, not null. */
  is_vacant_land: { nullable: false, fallback: false },
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
  for (const row of rows) {
    await projectProperty(tx, registry, row.id);
  }
  return { projected: rows.length };
}

/** The columns this projector owns. Exported so tests can assert nothing else writes them. */
export function projectableColumns(): readonly string[] {
  return Object.keys(PROJECTABLE);
}
