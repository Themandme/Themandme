import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigurationError } from './env.js';

/**
 * Validation for `config/scoring/v1.yaml` (spec §6.2).
 *
 * M0 ships the schema and the loader only. The engine that consumes this is M3; nothing here
 * computes a score.
 */

const probability = z.number().min(0).max(1);
const positiveInt = z.number().int().positive();

const EngineBaseSchema = z.object({
  base_p_pay: probability,
  default_days_to_cash: positiveInt,
  default_human_minutes: positiveInt,
});

export const ScoringConfigSchema = z
  .object({
    version: z.string().min(1),

    gate: z.object({
      ev_multiple: z.number().positive(),
      skiptrace_min_rank: z.number().min(0).max(100),
      ai_briefing_min_rank: z.number().min(0).max(100),
    }),

    bootstrap: z.object({
      /* §6.3 MUST: these weights are what make a $100/95%/7d/$5 recovery outrank a
         $10,000/30%/90d/$200 wholesale. AT-3 pins that behaviour. */
      weights: z.object({
        p_pay: probability,
        speed: probability,
        cost: probability,
        human_effort: probability,
        payout: probability,
      }),
      speed_halflife_days: z.number().positive(),
      payout_log_base: z.number().gt(1),
    }),

    signals: z.object({
      weights: z.record(z.string().min(1), probability),
      combination: z.literal('bounded_sum'),
    }),

    engines: z.object({
      wholesale: EngineBaseSchema.extend({
        min_spread_cents: positiveInt,
      }),
      land: EngineBaseSchema.extend({
        require_buyer_match: z.boolean(),
      }),
      recovery: EngineBaseSchema.extend({
        /* §2.5: recovery outreach is flag-gated pending a legal answer on finder's fees. */
        outreach_enabled: z.boolean(),
      }),
    }),
  })
  .superRefine((config, ctx) => {
    const weights = Object.values(config.bootstrap.weights);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    /* Float tolerance, not a judgement call: these are ranking weights and must be a mixture. */
    if (Math.abs(total - 1) > 1e-9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bootstrap', 'weights'],
        message: `bootstrap weights must sum to 1, got ${String(total)}`,
      });
    }
  });

export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

/** Parse and validate scoring config from a YAML string. Throws `ConfigurationError`. */
export function parseScoringConfig(yaml: string, sourceLabel = '<inline>'): ScoringConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (error) {
    throw new ConfigurationError([
      `${sourceLabel}: not valid YAML — ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const parsed = ScoringConfigSchema.safeParse(raw);
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

/** Read and validate a scoring config file. */
export function loadScoringConfig(filePath: string): ScoringConfig {
  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigurationError([
      `${filePath}: could not be read — ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  return parseScoringConfig(contents, filePath);
}
