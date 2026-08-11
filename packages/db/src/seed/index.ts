import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FeatureFlagsConfigSchema,
  loadYamlConfig,
  MarketConfigSchema,
  PredicatesConfigSchema,
  SourcesConfigSchema,
  SpendCapsConfigSchema,
} from '@magnolia/config';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../client.js';
import { featureFlags, markets, sources, spendCaps } from '../schema/markets.js';
import { predicates } from '../schema/facts.js';

/**
 * Seed. BUILD_PLAN M1.2.
 *
 * Idempotent by construction, and idempotent *observably*: rather than blind upserts, each row
 * is compared field-by-field against what is already there and written only when it differs.
 * A blind `ON CONFLICT DO UPDATE` would also converge, but every run would bump `updated_at`
 * and report work it did not do — which makes "re-running changes nothing" (invariant 7)
 * impossible to actually check.
 */

export interface SeedCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

export type SeedReport = Record<string, SeedCounts>;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function configDir(): string {
  return path.join(repoRoot, 'config');
}

function emptyCounts(): SeedCounts {
  return { inserted: 0, updated: 0, unchanged: 0 };
}

/** Structural comparison. Seeded values are plain JSON, so this is sufficient and cheap. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sortKeys);
  if (input === null || typeof input !== 'object') return input;
  const record = input as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
}

/** True when every managed field already matches. */
function matches(existing: object, desired: Record<string, unknown>): boolean {
  const row = existing as Record<string, unknown>;
  return Object.entries(desired).every(([key, value]) => sameValue(row[key], value));
}

export async function seed(db: Db): Promise<SeedReport> {
  const report: SeedReport = {};

  const marketConfig = loadYamlConfig(
    MarketConfigSchema,
    path.join(configDir(), 'markets/baltimore.yaml'),
  );
  const sourcesConfig = loadYamlConfig(
    SourcesConfigSchema,
    path.join(configDir(), 'sources/baltimore-v1.yaml'),
  );
  const predicatesConfig = loadYamlConfig(
    PredicatesConfigSchema,
    path.join(configDir(), 'predicates/v1.yaml'),
  );
  const flagsConfig = loadYamlConfig(
    FeatureFlagsConfigSchema,
    path.join(configDir(), 'feature-flags/v1.yaml'),
  );
  const capsConfig = loadYamlConfig(
    SpendCapsConfigSchema,
    path.join(configDir(), 'spend-caps/v1.yaml'),
  );

  /* ── Market ────────────────────────────────────────────────────────────────────────── */
  const marketCounts = emptyCounts();
  const desiredMarket = {
    key: marketConfig.key,
    displayName: marketConfig.display_name,
    stateCode: marketConfig.state_code,
    fipsCounty: marketConfig.fips_county ?? null,
    timezone: marketConfig.timezone,
    status: marketConfig.status,
    config: marketConfig.config as Record<string, unknown>,
  };

  const [existingMarket] = await db
    .select()
    .from(markets)
    .where(eq(markets.key, marketConfig.key))
    .limit(1);

  let marketId: string;
  if (existingMarket === undefined) {
    marketId = uuidv7();
    await db.insert(markets).values({ id: marketId, ...desiredMarket });
    marketCounts.inserted += 1;
  } else {
    marketId = existingMarket.id;
    if (matches(existingMarket, desiredMarket)) {
      marketCounts.unchanged += 1;
    } else {
      await db
        .update(markets)
        .set({ ...desiredMarket, updatedAt: new Date() })
        .where(eq(markets.id, marketId));
      marketCounts.updated += 1;
    }
  }
  report['markets'] = marketCounts;

  /* ── Sources ───────────────────────────────────────────────────────────────────────── */
  const sourceCounts = emptyCounts();
  for (const source of sourcesConfig.sources) {
    /* Internal producers are market-agnostic; external feeds belong to Baltimore. */
    const isInternal = source.access_method === 'internal';
    const desired = {
      key: source.key,
      marketId: isInternal ? null : marketId,
      displayName: source.display_name,
      tier: source.tier,
      baseUrl: source.base_url ?? null,
      accessMethod: source.access_method,
      licenseNote: source.license_note ?? null,
      scrapingAllowed: source.scraping_allowed,
      refreshCron: source.refresh_cron,
      baseConfidence: source.base_confidence,
      enabled: source.enabled,
    };

    const [existing] = await db.select().from(sources).where(eq(sources.key, source.key)).limit(1);
    if (existing === undefined) {
      await db.insert(sources).values({ id: uuidv7(), ...desired });
      sourceCounts.inserted += 1;
    } else if (matches(existing, desired)) {
      sourceCounts.unchanged += 1;
    } else {
      await db.update(sources).set(desired).where(eq(sources.id, existing.id));
      sourceCounts.updated += 1;
    }
  }
  report['sources'] = sourceCounts;

  /* ── Predicates ────────────────────────────────────────────────────────────────────── */
  const predicateCounts = emptyCounts();
  for (const predicate of predicatesConfig.predicates) {
    const desired = {
      key: predicate.key,
      subject: predicate.subject,
      valueSchema: predicate.value_schema,
      defaultTtlDays: predicate.default_ttl_days,
      volatility: predicate.volatility,
      description: predicate.description ?? null,
      readModelColumn: predicate.read_model_column ?? null,
      tolerance: predicate.tolerance ?? null,
      conflictEscalate: predicate.conflict_escalate ?? false,
    };

    const [existing] = await db
      .select()
      .from(predicates)
      .where(eq(predicates.key, predicate.key))
      .limit(1);
    if (existing === undefined) {
      await db.insert(predicates).values(desired);
      predicateCounts.inserted += 1;
    } else if (matches(existing, desired)) {
      predicateCounts.unchanged += 1;
    } else {
      await db.update(predicates).set(desired).where(eq(predicates.key, predicate.key));
      predicateCounts.updated += 1;
    }
  }
  report['predicates'] = predicateCounts;

  /* ── Feature flags ─────────────────────────────────────────────────────────────────── */
  const flagCounts = emptyCounts();
  for (const flag of flagsConfig.flags) {
    /* Only `note` is reconciled on an existing flag. `enabled` is deliberately NOT overwritten:
       an operator who turned something on (or a kill switch someone hit) must not be silently
       reverted by a deploy running the seed. New flags still arrive disabled. */
    const [existing] = await db
      .select()
      .from(featureFlags)
      .where(eq(featureFlags.key, flag.key))
      .limit(1);

    if (existing === undefined) {
      await db.insert(featureFlags).values({
        key: flag.key,
        enabled: flag.enabled,
        note: flag.note ?? null,
        updatedBy: 'seed',
      });
      flagCounts.inserted += 1;
    } else if (sameValue(existing.note, flag.note ?? null)) {
      flagCounts.unchanged += 1;
    } else {
      await db
        .update(featureFlags)
        .set({ note: flag.note ?? null, updatedBy: 'seed', updatedAt: new Date() })
        .where(eq(featureFlags.key, flag.key));
      flagCounts.updated += 1;
    }
  }
  report['feature_flags'] = flagCounts;

  /* ── Spend caps ────────────────────────────────────────────────────────────────────── */
  const capCounts = emptyCounts();
  for (const cap of capsConfig.caps) {
    const desired = {
      scope: cap.scope,
      period: cap.period,
      capCents: cap.cap_cents,
      hardStop: cap.hard_stop,
    };

    const [existing] = await db
      .select()
      .from(spendCaps)
      .where(and(eq(spendCaps.scope, cap.scope), eq(spendCaps.period, cap.period)))
      .limit(1);

    if (existing === undefined) {
      await db.insert(spendCaps).values({ id: uuidv7(), ...desired });
      capCounts.inserted += 1;
    } else if (matches(existing, desired)) {
      capCounts.unchanged += 1;
    } else {
      await db.update(spendCaps).set(desired).where(eq(spendCaps.id, existing.id));
      capCounts.updated += 1;
    }
  }
  report['spend_caps'] = capCounts;

  return report;
}

/** Total rows written across every table — 0 on a re-run. */
export function totalChanges(report: SeedReport): number {
  return Object.values(report).reduce((sum, c) => sum + c.inserted + c.updated, 0);
}
