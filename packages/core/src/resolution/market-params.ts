import { ConfigurationError } from '@magnolia/config';
import { markets } from '@magnolia/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../facts/record-fact.js';

/**
 * Resolution parameters, read from the market row rather than from constants.
 *
 * CLAUDE.md: "market parameters live in `config/`, never in code." That rule has teeth here
 * specifically — these two numbers decide whether two source records become one property, and a
 * code-level default would mean an operator could edit `config/markets/baltimore.yaml`, re-seed,
 * and still get the old behaviour with nothing to indicate why.
 *
 * So there is deliberately **no fallback**. A market whose config lacks these keys throws, which
 * is the loud failure; silently resolving at some compiled-in threshold is the quiet one.
 */

export interface ResolutionParams {
  /** `pg_trgm` similarity on the street portion at or above which a candidate is considered. */
  fuzzyThreshold: number;
  /** A parcel centroid within this many metres confirms a candidate. */
  centroidConfirmMetres: number;
}

/**
 * The slice of `markets.config` that resolution needs.
 *
 * Narrower than `MarketConfigSchema` in `@magnolia/config` on purpose: that schema validates the
 * YAML the seed writes, and requires every key a market has. Validating the whole thing here
 * would make an unrelated missing key (say `stale_days`) break entity resolution, which is both
 * confusing and wrong — resolution genuinely does not care.
 */
const ResolutionParamsSchema = z.object({
  fuzzy_address_threshold: z.number().min(0).max(1),
  centroid_confirm_metres: z.number().positive(),
});

/** Read and validate the resolution parameters for a market. Throws if absent or malformed. */
export async function loadResolutionParams(
  db: DbOrTx,
  marketId: string,
): Promise<ResolutionParams> {
  const [row] = await db
    .select({ key: markets.key, config: markets.config })
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1);

  if (row === undefined) {
    throw new ConfigurationError([`no market with id ${marketId}`]);
  }

  const parsed = ResolutionParamsSchema.safeParse(row.config);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map(
        (issue) =>
          `market "${row.key}" config.${issue.path.join('.')}: ${issue.message} — ` +
          `set it in config/markets/${row.key}.yaml and re-seed`,
      ),
    );
  }

  return {
    fuzzyThreshold: parsed.data.fuzzy_address_threshold,
    centroidConfirmMetres: parsed.data.centroid_confirm_metres,
  };
}
