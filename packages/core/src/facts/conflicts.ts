import { factConflicts, facts, sources } from '@magnolia/db';
import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { PredicateRegistry } from './predicate-registry.js';
import type { DbOrTx, SubjectType } from './record-fact.js';

/**
 * Conflict detection and resolution. Spec §4.1 rule 6 and §4.2.
 *
 * Rule 6: "when two *current* facts on the same subject+predicate disagree beyond a
 * per-predicate tolerance, write a `fact_conflicts` row instead of silently picking."
 *
 * The silent pick is the thing being prevented. Two sources disagreeing about whether a
 * property is in foreclosure is not a tie to break quietly — it is a fact about our data that
 * someone needs to see.
 */

/**
 * §4.2 resolution order, highest authority first. `human` overrides everything: an operator
 * who has looked at the deed outranks any feed.
 */
const TIER_RANK: Record<string, number> = {
  human: 0,
  official_record: 1,
  commercial_data: 2,
  secondary: 3,
  derived: 4,
  ai_inference: 5,
};

function rankOf(tier: string): number {
  return TIER_RANK[tier] ?? Number.MAX_SAFE_INTEGER;
}

/** The shape `preferenceOrder` needs. Deliberately minimal so any query shape can satisfy it. */
export interface RankableFact {
  id: string;
  observedAt: Date;
  tier: string;
}

/**
 * The §4.2 preference order: tier, then most recently observed, then fact id.
 *
 * Exported so the batched projector sorts by *this function* rather than by a reimplementation
 * of it. Two copies of this comparator would be two places for the read model to disagree with
 * itself, and the disagreement would be silent — a property projected in a batch would get a
 * different value from the same property projected alone, with nothing to indicate which was
 * right.
 *
 * The id tie-break is what makes the order **total**. Without it the projector's output depends
 * on the order Postgres happens to return rows in, and the property test's "equals a from-scratch
 * recomputation" claim becomes a coin flip. Fact ids are UUIDv7, so it is also time-ordered.
 */
export function preferenceOrder(a: RankableFact, b: RankableFact): number {
  const byTier = rankOf(a.tier) - rankOf(b.tier);
  if (byTier !== 0) return byTier;
  const byTime = b.observedAt.getTime() - a.observedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Two current values agree when they are equal, or within the predicate's tolerance. */
export function valuesAgree(a: unknown, b: unknown, tolerance: number | null): boolean {
  if (typeof a === 'number' && typeof b === 'number' && tolerance !== null) {
    return Math.abs(a - b) <= tolerance;
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonical);
  if (input === null || typeof input !== 'object') return input;
  const record = input as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key])]),
  );
}

export interface DetectedConflict {
  conflictId: string;
  predicate: string;
  factIds: string[];
  created: boolean;
}

/**
 * Detect a disagreement among the current facts for one subject+predicate.
 *
 * Idempotent: an unresolved conflict row for the same subject+predicate is reused rather than
 * duplicated, so a nightly sweep does not accumulate copies of the same disagreement.
 */
export async function detectConflicts(
  tx: DbOrTx,
  registry: PredicateRegistry,
  subjectType: SubjectType,
  subjectId: string,
  predicate: string,
): Promise<DetectedConflict | undefined> {
  const definition = registry.get(predicate);
  if (definition === undefined) return undefined;

  const current = await tx
    .select()
    .from(facts)
    .where(
      and(
        eq(facts.subjectType, subjectType),
        eq(facts.subjectId, subjectId),
        eq(facts.predicate, predicate),
        eq(facts.isCurrent, true),
      ),
    );

  if (current.length < 2) return undefined;

  const disagrees = current.some((candidate) =>
    current.some((other) => !valuesAgree(candidate.value, other.value, definition.tolerance)),
  );
  if (!disagrees) return undefined;

  const factIds = current.map((row) => row.id).sort();

  const [existing] = await tx
    .select()
    .from(factConflicts)
    .where(
      and(
        eq(factConflicts.subjectType, subjectType),
        eq(factConflicts.subjectId, subjectId),
        eq(factConflicts.predicate, predicate),
        isNull(factConflicts.resolvedAt),
      ),
    )
    .limit(1);

  if (existing !== undefined) {
    return { conflictId: existing.id, predicate, factIds, created: false };
  }

  const conflictId = uuidv7();
  await tx.insert(factConflicts).values({
    id: conflictId,
    subjectType,
    subjectId,
    predicate,
    factIds,
    resolution: definition.conflictEscalate ? 'operator' : null,
  });

  return { conflictId, predicate, factIds, created: true };
}

export type ConflictResolution =
  | { resolved: true; rule: 'prefer_tier' | 'prefer_recent'; factId: string }
  | { resolved: false; reason: 'escalated' | 'already_resolved' | 'not_found' | 'no_candidates' };

/**
 * Resolve a conflict by the §4.2 source hierarchy.
 *
 * Records *which* rule decided it — `prefer_tier` when one source outranks the others,
 * `prefer_recent` when same-tier sources are separated only by observation time. Spec §4.1
 * rule 6 requires that the resolver record the rule it used, because "the higher tier won" and
 * "they were equal and this one was newer" are different claims about our confidence.
 *
 * Predicates flagged `conflict_escalate` are never auto-resolved: they are left for a human,
 * with `resolution = 'operator'` and `resolved_at` still null.
 */
export async function resolveConflict(
  tx: DbOrTx,
  registry: PredicateRegistry,
  conflictId: string,
  resolvedBy = 'system',
): Promise<ConflictResolution> {
  const [conflict] = await tx
    .select()
    .from(factConflicts)
    .where(eq(factConflicts.id, conflictId))
    .limit(1);

  if (conflict === undefined) return { resolved: false, reason: 'not_found' };
  if (conflict.resolvedAt !== null) return { resolved: false, reason: 'already_resolved' };

  const definition = registry.get(conflict.predicate);
  if (definition?.conflictEscalate === true) {
    /* Left deliberately unresolved. Marking it 'operator' is what surfaces it to a human;
       auto-resolving a PHIFA or deceased-owner disagreement is exactly the silent pick the
       rule exists to prevent. */
    if (conflict.resolution !== 'operator') {
      await tx
        .update(factConflicts)
        .set({ resolution: 'operator' })
        .where(eq(factConflicts.id, conflictId));
    }
    return { resolved: false, reason: 'escalated' };
  }

  const candidates = await tx
    .select({
      id: facts.id,
      observedAt: facts.observedAt,
      tier: sources.tier,
      isCurrent: facts.isCurrent,
    })
    .from(facts)
    .innerJoin(sources, eq(facts.sourceId, sources.id))
    .where(
      and(
        eq(facts.subjectType, conflict.subjectType),
        eq(facts.subjectId, conflict.subjectId),
        eq(facts.predicate, conflict.predicate),
        eq(facts.isCurrent, true),
      ),
    );

  if (candidates.length === 0) return { resolved: false, reason: 'no_candidates' };

  const sorted = [...candidates].sort((a, b) => {
    const byTier = rankOf(a.tier) - rankOf(b.tier);
    if (byTier !== 0) return byTier;
    return b.observedAt.getTime() - a.observedAt.getTime();
  });

  const winner = sorted[0];
  if (winner === undefined) return { resolved: false, reason: 'no_candidates' };

  /* Which rule actually decided it: if the runner-up shares the winner's tier, the tier did
     not separate them and recency did. */
  const runnerUp = sorted[1];
  const rule =
    runnerUp !== undefined && rankOf(runnerUp.tier) === rankOf(winner.tier)
      ? 'prefer_recent'
      : 'prefer_tier';

  await tx
    .update(factConflicts)
    .set({
      resolution: rule,
      resolvedFactId: winner.id,
      resolvedBy,
      resolvedAt: new Date(),
    })
    .where(eq(factConflicts.id, conflictId));

  return { resolved: true, rule, factId: winner.id };
}

/**
 * The current fact that wins for a subject+predicate under the §4.2 hierarchy.
 *
 * Used by the read-model projector, which needs a single value per column. Returning the
 * hierarchy winner here does NOT resolve or suppress a conflict row — detection still records
 * the disagreement; this only decides what the read model displays in the meantime.
 */
export async function preferredFact(
  tx: DbOrTx,
  subjectType: SubjectType,
  subjectId: string,
  predicate: string,
): Promise<{ id: string; value: unknown; tier: string } | undefined> {
  const rows = await tx
    .select({
      id: facts.id,
      value: facts.value,
      observedAt: facts.observedAt,
      tier: sources.tier,
    })
    .from(facts)
    .innerJoin(sources, eq(facts.sourceId, sources.id))
    .where(
      and(
        eq(facts.subjectType, subjectType),
        eq(facts.subjectId, subjectId),
        eq(facts.predicate, predicate),
        eq(facts.isCurrent, true),
      ),
    );

  if (rows.length === 0) return undefined;

  const sorted = [...rows].sort(preferenceOrder);
  const winner = sorted[0];
  return winner === undefined
    ? undefined
    : { id: winner.id, value: winner.value, tier: winner.tier };
}
