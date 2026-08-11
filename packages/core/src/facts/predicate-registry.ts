import { predicates, type Db } from '@magnolia/db';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Predicate registry. BUILD_PLAN M1.4, spec §4.1.
 *
 * "Writing a fact with an unregistered predicate, or a value failing the predicate's JSON
 * Schema, throws." Both throw — neither returns a falsy value a caller could ignore, matching
 * the posture of `requestStage` in §5.1.
 *
 * The registry is built per database rather than cached module-globally: tests run against
 * scratch databases, and a global cache keyed on predicate name alone would leak one test's
 * schema into another's.
 */

export class UnregisteredPredicateError extends Error {
  readonly predicate: string;
  constructor(predicate: string, known: number) {
    super(
      `Unregistered predicate "${predicate}". Every predicate must be declared in ` +
        `config/predicates/v1.yaml and seeded (${String(known)} are registered). ` +
        `Spec §4.1: writing an unregistered predicate is a bug, not a new predicate.`,
    );
    this.name = 'UnregisteredPredicateError';
    this.predicate = predicate;
  }
}

export class PredicateValueError extends Error {
  readonly predicate: string;
  readonly issues: readonly string[];
  constructor(predicate: string, issues: readonly string[]) {
    super(
      `Value rejected by the schema for predicate "${predicate}":\n` +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
    this.name = 'PredicateValueError';
    this.predicate = predicate;
    this.issues = issues;
  }
}

export interface RegisteredPredicate {
  key: string;
  subject: string;
  volatility: string;
  defaultTtlDays: number | null;
  /** `properties.<column>` this predicate projects into, if any. Spec §4.1 rule 4. */
  readModelColumn: string | null;
  /** Numeric predicates: two current values differing by more than this are in conflict. */
  tolerance: number | null;
  /** True = a conflict here goes to a human rather than the source hierarchy (§4.1 rule 6). */
  conflictEscalate: boolean;
}

export interface PredicateRegistry {
  /** Throws `UnregisteredPredicateError` / `PredicateValueError`. Returns the definition. */
  assert: (predicate: string, value: unknown) => RegisteredPredicate;
  get: (predicate: string) => RegisteredPredicate | undefined;
  keys: () => readonly string[];
  /** Every predicate that projects into a read-model column. */
  projecting: () => readonly RegisteredPredicate[];
}

/** Load every predicate and compile its `value_schema`. */
export async function loadPredicateRegistry(db: Db): Promise<PredicateRegistry> {
  const rows = await db.select().from(predicates);

  const ajv = new Ajv({ allErrors: true, strict: false });
  /* ajv-formats ships a CJS default export; under verbatimModuleSyntax the namespace object
     is what lands here, so the callable is one level in. */
  (addFormats as unknown as { default: (a: Ajv) => void }).default(ajv);

  const compiled = new Map<string, { def: RegisteredPredicate; validate: ValidateFunction }>();

  for (const row of rows) {
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(row.valueSchema as object);
    } catch (error) {
      /* A malformed value_schema is a configuration bug and must surface at load, not on the
         first fact that happens to use the predicate. */
      throw new Error(
        `predicate "${row.key}" has an invalid value_schema: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    compiled.set(row.key, {
      def: {
        key: row.key,
        subject: row.subject,
        volatility: row.volatility,
        defaultTtlDays: row.defaultTtlDays,
        readModelColumn: row.readModelColumn,
        tolerance: row.tolerance,
        conflictEscalate: row.conflictEscalate,
      },
      validate,
    });
  }

  return {
    assert(predicate, value) {
      const entry = compiled.get(predicate);
      if (entry === undefined) {
        throw new UnregisteredPredicateError(predicate, compiled.size);
      }
      if (!entry.validate(value)) {
        const issues = (entry.validate.errors ?? []).map(
          (err) => `${err.instancePath === '' ? '(root)' : err.instancePath} ${err.message ?? ''}`,
        );
        throw new PredicateValueError(predicate, issues);
      }
      return entry.def;
    },
    get: (predicate) => compiled.get(predicate)?.def,
    keys: () => [...compiled.keys()],
    projecting: () =>
      [...compiled.values()].map((e) => e.def).filter((d) => d.readModelColumn !== null),
  };
}
