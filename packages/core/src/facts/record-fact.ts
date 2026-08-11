import { facts, sources, type Db } from '@magnolia/db';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { PredicateRegistry } from './predicate-registry.js';

/**
 * `recordFact` — the only write path into `facts` (CLAUDE.md invariant 1).
 *
 * Ingestors write `raw_records`; normalizers call this. Nothing else writes facts, and the
 * property/person scalar columns are a read model recomputed by the projector, never written
 * here.
 */

export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type EpistemicLevel = 'fact' | 'prediction' | 'inference';

export type SubjectType =
  | 'property'
  | 'parcel'
  | 'person'
  | 'organization'
  | 'contact'
  | 'buyer'
  | 'opportunity'
  | 'transaction';

/**
 * Spec §4.1 rule 3: "Only a producer whose source tier is `official_record`,
 * `commercial_data`, or `human` may write `fact`."
 */
const TIERS_THAT_MAY_ASSERT_FACT = new Set(['official_record', 'commercial_data', 'human']);

export class EpistemicViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpistemicViolationError';
  }
}

export class UnknownSourceError extends Error {
  constructor(sourceId: string) {
    super(
      `No source row for source_id "${sourceId}". Spec §4.1 rule 2: there is no default ` +
        `source, and a fact with no provenance is a bug.`,
    );
    this.name = 'UnknownSourceError';
  }
}

export interface FactDraft {
  subjectType: SubjectType;
  subjectId: string;
  predicate: string;
  value: unknown;
  epistemic: EpistemicLevel;
  /** Required. There is no default source (spec §4.1 rule 2). */
  sourceId: string;
  /** When it was true in the world — not when we learned it. */
  observedAt: Date;
  confidence: number;
  sourceRecordId?: string;
  rawRecordId?: string;
  derivedFrom?: string[];
  costCents?: number;
}

export interface RecordedFact {
  id: string;
  created: boolean;
  supersededFactId: string | null;
}

function sameJson(a: unknown, b: unknown): boolean {
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

/**
 * Record a fact.
 *
 * - Validates the predicate and value through the registry (throws on either failure).
 * - Enforces the epistemic rule against the source's tier.
 * - Derives `expires_at` from the predicate's TTL.
 * - Supersedes the prior current fact for the same (subject, predicate, source), in order:
 *   the old row's `is_current` is cleared *before* the new row is inserted, because
 *   `facts_one_current_per_source` would otherwise reject the insert.
 * - Is idempotent: an identical write returns the existing row and writes nothing.
 *
 * Must be called inside a transaction when the caller has other writes to keep atomic with it.
 */
export async function recordFact(
  tx: DbOrTx,
  registry: PredicateRegistry,
  draft: FactDraft,
): Promise<RecordedFact> {
  const definition = registry.assert(draft.predicate, draft.value);

  if (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) {
    throw new RangeError(
      `confidence must be in [0,1], received ${String(draft.confidence)} for "${draft.predicate}"`,
    );
  }

  const [source] = await tx
    .select({ id: sources.id, tier: sources.tier })
    .from(sources)
    .where(eq(sources.id, draft.sourceId))
    .limit(1);
  if (source === undefined) throw new UnknownSourceError(draft.sourceId);

  /* Spec §4.1 rule 3 and CLAUDE.md invariant 2. Both directions are enforced: a low-tier
     source cannot claim `fact`, and an LLM source cannot claim anything but `inference`. */
  if (draft.epistemic === 'fact' && !TIERS_THAT_MAY_ASSERT_FACT.has(source.tier)) {
    throw new EpistemicViolationError(
      `Source tier "${source.tier}" may not write epistemic='fact' for "${draft.predicate}". ` +
        `Spec §4.1 rule 3 restricts 'fact' to official_record, commercial_data and human.`,
    );
  }
  if (source.tier === 'ai_inference' && draft.epistemic !== 'inference') {
    throw new EpistemicViolationError(
      `Source tier "ai_inference" must write epistemic='inference', not ` +
        `'${draft.epistemic}'. CLAUDE.md invariant 2: LLM output is always inference.`,
    );
  }

  const expiresAt =
    definition.defaultTtlDays === null
      ? null
      : new Date(draft.observedAt.getTime() + definition.defaultTtlDays * 86_400_000);

  const [existing] = await tx
    .select()
    .from(facts)
    .where(
      and(
        eq(facts.subjectType, draft.subjectType),
        eq(facts.subjectId, draft.subjectId),
        eq(facts.predicate, draft.predicate),
        eq(facts.sourceId, draft.sourceId),
        eq(facts.isCurrent, true),
      ),
    )
    .limit(1);

  if (existing !== undefined) {
    /* Idempotency (invariant 7). Re-running ingestion over identical source data must create
       nothing new. Note that the primary dedupe happens upstream — `raw_records_dedupe` stops
       an unchanged payload from being normalized twice — so this is the second line, covering
       a normalizer invoked directly. */
    const identical =
      sameJson(existing.value, draft.value) &&
      existing.epistemic === draft.epistemic &&
      existing.observedAt.getTime() === draft.observedAt.getTime() &&
      existing.confidence === draft.confidence;

    if (identical) {
      return { id: existing.id, created: false, supersededFactId: null };
    }
  }

  const id = uuidv7();

  /*
   * Superseding takes three statements, and the order is forced by two constraints pulling
   * in opposite directions:
   *
   *   - `facts_one_current_per_source` (partial unique over is_current) requires the old row
   *     to stop being current BEFORE the new row is inserted.
   *   - `facts_superseded_by_facts_id_fk` requires the new row to EXIST before the old row
   *     can point at it.
   *
   * So: clear is_current, insert, then link. Doing it in two statements satisfies one
   * constraint or the other but never both.
   *
   * Wrapped in a transaction unconditionally — a nested call becomes a savepoint — so a
   * failure between steps cannot leave a fact with no current row for its source.
   */
  await tx.transaction(async (inner) => {
    if (existing !== undefined) {
      await inner.update(facts).set({ isCurrent: false }).where(eq(facts.id, existing.id));
    }

    await inner.insert(facts).values({
      id,
      subjectType: draft.subjectType,
      subjectId: draft.subjectId,
      predicate: draft.predicate,
      value: draft.value,
      epistemic: draft.epistemic,
      sourceId: draft.sourceId,
      sourceRecordId: draft.sourceRecordId ?? null,
      rawRecordId: draft.rawRecordId ?? null,
      derivedFrom: draft.derivedFrom ?? null,
      observedAt: draft.observedAt,
      expiresAt,
      confidence: draft.confidence,
      costCents: draft.costCents ?? 0,
      isCurrent: true,
    });

    if (existing !== undefined) {
      await inner.update(facts).set({ superseded: id }).where(eq(facts.id, existing.id));
    }
  });

  return { id, created: true, supersededFactId: existing?.id ?? null };
}

/** Current facts for a subject, newest observation first. */
export async function currentFacts(
  tx: DbOrTx,
  subjectType: SubjectType,
  subjectId: string,
): Promise<(typeof facts.$inferSelect)[]> {
  return tx
    .select()
    .from(facts)
    .where(
      and(
        eq(facts.subjectType, subjectType),
        eq(facts.subjectId, subjectId),
        eq(facts.isCurrent, true),
      ),
    )
    .orderBy(sql`${facts.observedAt} DESC`);
}

/** Current facts for one subject+predicate. More than one means different sources disagree. */
export async function currentFactsFor(
  tx: DbOrTx,
  subjectType: SubjectType,
  subjectId: string,
  predicate: string,
): Promise<(typeof facts.$inferSelect)[]> {
  return tx
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
}
