import { featureFlags, sources, type Db } from '@magnolia/db';
import { eq } from 'drizzle-orm';
import type { DataSourceAdapter } from './types.js';

/**
 * Adapter registry and the guard that decides whether an adapter may run at all.
 *
 * The check lives here rather than inside each adapter so a new adapter cannot forget it. The
 * seed deliberately keeps `md.case_search` and `md.land_records` non-scrapable (spec §4.5 MUST,
 * both ToS-restricted and unverified), and that protection should be structural rather than a
 * matter of per-adapter discipline.
 *
 * Every check **throws**. It never returns a falsy value a caller could ignore — the same
 * posture as `requestStage` (§5.1) and `recordFact`. A source that must not be fetched is not a
 * no-op; it is an error, and a silent skip would be indistinguishable from a source that simply
 * had no new records.
 *
 * Note the normal answer today is "no": every external source seeds `enabled: false` (invariant
 * 8), so enabling one is a deliberate act.
 */

export class SourceNotRegisteredError extends Error {
  constructor(key: string, known: readonly string[]) {
    super(
      `No adapter registered for source "${key}". Registered: ${known.join(', ') || '(none)'}.`,
    );
    this.name = 'SourceNotRegisteredError';
  }
}

export class SourceRowMissingError extends Error {
  constructor(key: string) {
    super(
      `No \`sources\` row for "${key}". An adapter cannot run without one: facts.source_id is ` +
        `NOT NULL, so every fact it produced would be unprovenanced. Seed the source first.`,
    );
    this.name = 'SourceRowMissingError';
  }
}

export class SourceDisabledError extends Error {
  readonly reason: 'disabled' | 'scraping_not_allowed' | 'flag_off';

  constructor(key: string, reason: 'disabled' | 'scraping_not_allowed' | 'flag_off') {
    const detail = {
      disabled: `sources.enabled is false. Enabling a source is a deliberate act (invariant 8).`,
      scraping_not_allowed:
        `sources.scraping_allowed is false. Spec §4.5: a ToS-restricted source is reachable ` +
        `only by manual operator lookup recorded as a human-tier fact. Do not flip this ` +
        `without the written terms review in §17.6.`,
      flag_off: `the feature flag "source.${key}" is off (spec §14 kill switches).`,
    }[reason];

    super(`Refusing to run adapter "${key}": ${detail}`);
    this.name = 'SourceDisabledError';
    this.reason = reason;
  }
}

export interface AdapterRegistry {
  register: (adapter: DataSourceAdapter) => void;
  keys: () => readonly string[];
  get: (key: string) => DataSourceAdapter | undefined;
  /**
   * Return the adapter only if the database permits it to run.
   * Throws `SourceNotRegisteredError`, `SourceRowMissingError` or `SourceDisabledError`.
   */
  requireRunnable: (db: Db, key: string) => Promise<DataSourceAdapter>;
}

export function createAdapterRegistry(initial: DataSourceAdapter[] = []): AdapterRegistry {
  const adapters = new Map<string, DataSourceAdapter>();
  for (const adapter of initial) adapters.set(adapter.key, adapter);

  return {
    register(adapter) {
      adapters.set(adapter.key, adapter);
    },

    keys: () => [...adapters.keys()],

    get: (key) => adapters.get(key),

    async requireRunnable(db, key) {
      const adapter = adapters.get(key);
      if (adapter === undefined) {
        throw new SourceNotRegisteredError(key, [...adapters.keys()]);
      }

      const [row] = await db
        .select({ enabled: sources.enabled, scrapingAllowed: sources.scrapingAllowed })
        .from(sources)
        .where(eq(sources.key, key))
        .limit(1);

      if (row === undefined) throw new SourceRowMissingError(key);

      /* Order matters for the message the operator sees: scraping_allowed is the legal
         constraint and should be reported even if the source also happens to be disabled. */
      if (!row.scrapingAllowed) throw new SourceDisabledError(key, 'scraping_not_allowed');
      if (!row.enabled) throw new SourceDisabledError(key, 'disabled');

      const [flag] = await db
        .select({ enabled: featureFlags.enabled })
        .from(featureFlags)
        .where(eq(featureFlags.key, `source.${key}`))
        .limit(1);

      /* A missing flag is off, not on. Invariant 8: kill switches default off, and an
         unseeded flag must not become an accidental permission. */
      if (flag?.enabled !== true) throw new SourceDisabledError(key, 'flag_off');

      return adapter;
    },
  };
}
