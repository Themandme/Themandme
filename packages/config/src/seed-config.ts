import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigurationError } from './env.js';

/**
 * Loaders for the seed configuration under `config/`.
 *
 * CLAUDE.md: market parameters, cohorts and weights live in `config/`, never in code. These
 * schemas are what stops a typo in a YAML file from becoming a silently-wrong database row.
 */

const SOURCE_TIERS = [
  'official_record',
  'commercial_data',
  'secondary',
  'derived',
  'ai_inference',
  'human',
] as const;

const VOLATILITIES = ['durable', 'slow', 'volatile'] as const;

const probability = z.number().min(0).max(1);
const nonEmpty = z.string().min(1);

/* ── Market ──────────────────────────────────────────────────────────────────────────── */

export const MarketConfigSchema = z.object({
  key: nonEmpty,
  display_name: nonEmpty,
  state_code: z.string().length(2),
  fips_county: z.string().nullable().optional(),
  timezone: nonEmpty,
  status: z.enum(['pilot', 'active', 'paused', 'retired']),
  config: z.object({
    aging_days: z.number().int().positive(),
    stale_days: z.number().int().positive(),
    max_touches_per_person_per_week: z.number().int().positive(),
    max_touches_per_person_per_day: z.number().int().positive(),
    max_signal_age_days: z.number().int().positive(),
    max_spend_per_opportunity_cents: z.number().int().positive(),
    /* §4.3 tier 3. See the measurement note in config/markets/baltimore.yaml. The threshold is a
       candidate RECALL floor, not a match decision — matching is structural (house number,
       fraction and unit exact; directional and suffix compatible) plus centroid confirmation. */
    fuzzy_address_threshold: probability,
    centroid_confirm_metres: z.number().positive(),
    calling_window_start_hour: z.number().int().min(0).max(23),
    calling_window_end_hour: z.number().int().min(0).max(23),
    /* [VERIFY] spec §2.5 — null until counsel answers. Null is the honest value; a guessed
       rate here would silently produce a recovery payout estimate. */
    recovery_allowable_fee_rate: probability.nullable(),
  }),
});
export type MarketConfig = z.infer<typeof MarketConfigSchema>;

/* ── Sources ─────────────────────────────────────────────────────────────────────────── */

export const SourcesConfigSchema = z.object({
  sources: z
    .array(
      z
        .object({
          key: nonEmpty,
          display_name: nonEmpty,
          tier: z.enum(SOURCE_TIERS),
          access_method: nonEmpty,
          base_url: z.string().url().nullable().optional(),
          scraping_allowed: z.boolean(),
          license_note: z.string().nullable().optional(),
          refresh_cron: z.string().nullable(),
          base_confidence: probability,
          enabled: z.boolean(),
        })
        .superRefine((source, ctx) => {
          /* Spec §4.5 MUST: a source whose terms restrict automation must be reachable only by
             manual operator lookup. Catching the contradiction here means a well-meaning edit
             that flips `scraping_allowed` without changing `access_method` fails at boot
             rather than at the first request to a site that forbids it. */
          if (source.scraping_allowed && source.access_method === 'manual_upload') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `source "${source.key}": scraping_allowed=true contradicts access_method=manual_upload`,
            });
          }
        }),
    )
    .min(1),
});
export type SourcesConfig = z.infer<typeof SourcesConfigSchema>;

/* ── Predicates ──────────────────────────────────────────────────────────────────────── */

export const PredicatesConfigSchema = z.object({
  predicates: z
    .array(
      z
        .object({
          key: nonEmpty,
          subject: z.enum([
            'property',
            'parcel',
            'person',
            'organization',
            'contact',
            'buyer',
            'opportunity',
            'transaction',
          ]),
          volatility: z.enum(VOLATILITIES),
          default_ttl_days: z.number().int().positive().nullable(),
          /* JSON Schema. Kept as an opaque record here and compiled by ajv in
             packages/core/src/facts/predicate-registry.ts, which is where a malformed schema
             surfaces. */
          value_schema: z.record(z.string(), z.unknown()),
          description: z.string().optional(),
          read_model_column: z.string().min(1).optional(),
          tolerance: z.number().min(0).optional(),
          conflict_escalate: z.boolean().optional(),
        })
        .superRefine((predicate, ctx) => {
          /* Spec §4.1: durable predicates never expire; slow and volatile ones must. A TTL
             that disagrees with its volatility class means the refresh sweep either never
             runs or runs forever. */
          const expectsTtl = predicate.volatility !== 'durable';
          if (expectsTtl && predicate.default_ttl_days === null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `predicate "${predicate.key}": volatility=${predicate.volatility} requires a default_ttl_days`,
            });
          }
          if (!expectsTtl && predicate.default_ttl_days !== null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `predicate "${predicate.key}": volatility=durable must have default_ttl_days: null`,
            });
          }
        }),
    )
    .min(1),
});
export type PredicatesConfig = z.infer<typeof PredicatesConfigSchema>;
export type PredicateDefinition = PredicatesConfig['predicates'][number];

/* ── Feature flags ───────────────────────────────────────────────────────────────────── */

export const FeatureFlagsConfigSchema = z.object({
  flags: z
    .array(
      z.object({
        key: nonEmpty,
        enabled: z.boolean(),
        note: z.string().optional(),
      }),
    )
    .min(1)
    .superRefine((flags, ctx) => {
      /* CLAUDE.md invariant 8. The seed is what a fresh production database gets, and the safe
         state on day one is that nothing runs. A flag shipped enabled would mean a deploy
         that starts spending or contacting before anyone chose to. */
      for (const flag of flags) {
        if (flag.enabled) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `feature flag "${flag.key}" ships enabled; invariant 8 requires every seeded flag to default off`,
          });
        }
      }
    }),
});
export type FeatureFlagsConfig = z.infer<typeof FeatureFlagsConfigSchema>;

/* ── Spend caps ──────────────────────────────────────────────────────────────────────── */

export const SpendCapsConfigSchema = z.object({
  caps: z
    .array(
      z.object({
        scope: nonEmpty,
        period: z.enum(['day', 'week', 'month', 'lifetime']),
        cap_cents: z.number().int().positive(),
        hard_stop: z.boolean(),
      }),
    )
    .min(1)
    .superRefine((caps, ctx) => {
      const seen = new Set<string>();
      for (const cap of caps) {
        const key = `${cap.scope}|${cap.period}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate spend cap for scope="${cap.scope}" period="${cap.period}"`,
          });
        }
        seen.add(key);
      }
    }),
});
export type SpendCapsConfig = z.infer<typeof SpendCapsConfigSchema>;

/* ── Loading ─────────────────────────────────────────────────────────────────────────── */

/** Parse and validate YAML against a schema, reporting every problem at once. */
export function parseYamlConfig<T>(schema: z.ZodType<T>, yaml: string, sourceLabel: string): T {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (error) {
    throw new ConfigurationError([
      `${sourceLabel}: not valid YAML — ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.join('.');
        return `${sourceLabel}${path === '' ? '' : ` at ${path}`}: ${issue.message}`;
      }),
    );
  }
  return parsed.data;
}

/** Read and validate a YAML config file. */
export function loadYamlConfig<T>(schema: z.ZodType<T>, filePath: string): T {
  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigurationError([
      `${filePath}: could not be read — ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  return parseYamlConfig(schema, contents, filePath);
}
