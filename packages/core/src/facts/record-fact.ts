import { facts, sources, type Db } from '@magnolia/db';
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
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

    /*
     * Supersede on OBSERVATION time, not arrival time.
     *
     * Spec §4.1 rule 5 says the newest fact from a source supersedes the older one. Comparing
     * only what is already current makes that rule depend on the order records happen to be
     * normalized in, which for many sources is arbitrary.
     *
     * It matters as soon as a source emits several records per property. `baltimore.vbn` emits
     * roughly one notice per property, so the bug is invisible there — but building permits,
     * code violations and 311 requests all emit many, in whatever order the service pages them.
     * Without this guard, ingesting a 2019 permit after a 2026 one leaves the 2019 date standing
     * as the property's current permit fact, and the read model then reports a rehab that
     * happened seven years ago as the latest.
     *
     * An older observation is not wrong, it is just not the current one, so it is dropped rather
     * than raised: the newer fact it would have replaced is already recorded and already correct.
     * Equal timestamps still supersede, because a source re-stating the same instant with a
     * different value is a correction and the later statement wins.
     */
    if (draft.observedAt.getTime() < existing.observedAt.getTime()) {
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

/* ── Batched writes ──────────────────────────────────────────────────────────────────────
 *
 * `recordFact` costs two to four round trips per fact: a source lookup, a lookup of the current
 * fact, then the insert and (when superseding) two more statements. Measured on the live SDAT
 * load that dominates ingestion — each record produces seven facts, so normalization ran at
 * 3,324 records/min and a full 237,260-parcel load needed roughly 70 minutes.
 *
 * `recordFacts` does the same work for a whole chunk in **five statements total**, regardless of
 * chunk size: one source lookup, one current-fact lookup, then the same three writes the
 * supersede ordering requires.
 *
 * Every check `recordFact` performs is performed here too — predicate and value schema,
 * confidence range, the epistemic rule against source tier, the identical-write short circuit,
 * and the observation-time guard. This function must not be a weaker door into the ledger than
 * the single-fact one; a batched path that skipped a validation would be a way to write facts
 * that `recordFact` would have refused.
 */

export interface BatchOutcome {
  created: number;
  /** Identical repeats and later-arriving older observations. */
  skipped: number;
  superseded: number;
}

/** `${subjectType}|${subjectId}|${predicate}|${sourceId}` — the uniqueness key of a current fact. */
function currentKey(d: {
  subjectType: string;
  subjectId: string;
  predicate: string;
  sourceId: string;
}): string {
  return `${d.subjectType}|${d.subjectId}|${d.predicate}|${d.sourceId}`;
}

export async function recordFacts(
  tx: DbOrTx,
  registry: PredicateRegistry,
  drafts: readonly FactDraft[],
): Promise<BatchOutcome> {
  if (drafts.length === 0) return { created: 0, skipped: 0, superseded: 0 };

  /*
   * Two drafts in one chunk for the same (subject, predicate, source) form a supersede CHAIN:
   * the second has to point at the first, which has to exist first. That cannot be expressed in
   * one batched insert, and collapsing the chain would silently drop a row of history.
   *
   * Rather than approximate it, those keys are routed through `recordFact` one at a time and the
   * rest are batched. Repeats are rare in practice — each raw record is a distinct property — so
   * this costs almost nothing while keeping the batched path's history byte-identical to the
   * sequential one.
   */
  const countByKey = new Map<string, number>();
  for (const draft of drafts) {
    const key = currentKey(draft);
    countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
  }
  const sequential = drafts.filter((d) => (countByKey.get(currentKey(d)) ?? 0) > 1);
  const batchable = drafts.filter((d) => (countByKey.get(currentKey(d)) ?? 0) === 1);

  let created = 0;
  let skipped = 0;
  let superseded = 0;

  for (const draft of sequential) {
    const result = await recordFact(tx, registry, draft);
    if (result.created) created += 1;
    else skipped += 1;
    if (result.supersededFactId !== null) superseded += 1;
  }

  if (batchable.length === 0) return { created, skipped, superseded };

  /* 1. Validation, in memory. Same calls, same order, same errors as `recordFact`. */
  const definitions = new Map<string, ReturnType<PredicateRegistry['assert']>>();
  for (const draft of batchable) {
    definitions.set(draft.predicate, registry.assert(draft.predicate, draft.value));
    if (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1) {
      throw new RangeError(
        `confidence must be in [0,1], received ${String(draft.confidence)} for "${draft.predicate}"`,
      );
    }
  }

  /* 2. One source lookup for the whole chunk. */
  const sourceIds = [...new Set(batchable.map((d) => d.sourceId))];
  const sourceRows = await tx
    .select({ id: sources.id, tier: sources.tier })
    .from(sources)
    .where(inArray(sources.id, sourceIds));
  const tierById = new Map(sourceRows.map((row) => [row.id, row.tier]));

  for (const draft of batchable) {
    const tier = tierById.get(draft.sourceId);
    if (tier === undefined) throw new UnknownSourceError(draft.sourceId);
    if (draft.epistemic === 'fact' && !TIERS_THAT_MAY_ASSERT_FACT.has(tier)) {
      throw new EpistemicViolationError(
        `Source tier "${tier}" may not write epistemic='fact' for "${draft.predicate}". ` +
          `Spec §4.1 rule 3 restricts 'fact' to official_record, commercial_data and human.`,
      );
    }
    if (tier === 'ai_inference' && draft.epistemic !== 'inference') {
      throw new EpistemicViolationError(
        `Source tier "ai_inference" must write epistemic='inference', not ` +
          `'${draft.epistemic}'. CLAUDE.md invariant 2: LLM output is always inference.`,
      );
    }
  }

  /*
   * 3. One lookup of the current facts this chunk might supersede.
   *
   * Filtered by the three columns of `facts_one_current_per_source` that are cheap to express as
   * sets. That is a superset of the exact tuple list — it can return a fact for a
   * subject/predicate combination no draft actually touches — so the result is keyed and matched
   * exactly below rather than being trusted as-is.
   */
  const existingRows = await tx
    .select({
      id: facts.id,
      subjectType: facts.subjectType,
      subjectId: facts.subjectId,
      predicate: facts.predicate,
      sourceId: facts.sourceId,
      value: facts.value,
      epistemic: facts.epistemic,
      observedAt: facts.observedAt,
      confidence: facts.confidence,
    })
    .from(facts)
    .where(
      and(
        /*
         * `subject_type` FIRST, and it is not optional.
         *
         * `facts_one_current_per_source` is
         * `(subject_type, subject_id, predicate, source_id) WHERE is_current`. Leaving the
         * LEADING column unconstrained makes the index unusable and Postgres falls back to a
         * sequential scan of the whole table — measured at 323,343 rows and 9,418 shared buffers
         * per chunk on a half-loaded `facts`, and growing with every chunk written. Adding it
         * takes the same query to an index-driven nested loop at 2,175 buffers.
         *
         * `recordFact` gets this for free because it filters on one exact tuple. The batched
         * version has to say it explicitly, and forgetting to is invisible in every test — the
         * results are identical, only the plan is different.
         */
        inArray(facts.subjectType, [...new Set(batchable.map((d) => d.subjectType))]),
        inArray(facts.subjectId, [...new Set(batchable.map((d) => d.subjectId))]),
        inArray(facts.predicate, [...new Set(batchable.map((d) => d.predicate))]),
        inArray(facts.sourceId, sourceIds),
        eq(facts.isCurrent, true),
      ),
    );
  const existingByKey = new Map(existingRows.map((row) => [currentKey(row), row]));

  /* 4. Decide. Identical writes and older observations are dropped, exactly as in `recordFact`. */
  const toInsert: { draft: FactDraft; id: string; supersedes: string | null }[] = [];

  for (const draft of batchable) {
    const existing = existingByKey.get(currentKey(draft));

    if (existing !== undefined) {
      const identical =
        sameJson(existing.value, draft.value) &&
        existing.epistemic === draft.epistemic &&
        existing.observedAt.getTime() === draft.observedAt.getTime() &&
        existing.confidence === draft.confidence;
      if (identical) {
        skipped += 1;
        continue;
      }
      /* Supersede on observation time, not arrival time — see the note in `recordFact`. */
      if (draft.observedAt.getTime() < existing.observedAt.getTime()) {
        skipped += 1;
        continue;
      }
    }

    toInsert.push({ draft, id: uuidv7(), supersedes: existing?.id ?? null });
  }

  if (toInsert.length === 0) return { created, skipped, superseded };

  /*
   * 5. The three writes, in the order the constraints force — the same ordering `recordFact`
   *    documents, just applied to a whole chunk at once:
   *
   *      a. clear `is_current` on every row being superseded, because
   *         `facts_one_current_per_source` would reject the inserts otherwise;
   *      b. insert the new rows;
   *      c. point the old rows at the new ones, which needs the new rows to exist.
   */
  const supersededIds = toInsert
    .map((entry) => entry.supersedes)
    .filter((id): id is string => id !== null);

  if (supersededIds.length > 0) {
    await tx.update(facts).set({ isCurrent: false }).where(inArray(facts.id, supersededIds));
  }

  await tx.insert(facts).values(
    toInsert.map(({ draft, id }) => {
      const definition = definitions.get(draft.predicate);
      const expiresAt =
        definition?.defaultTtlDays == null
          ? null
          : new Date(draft.observedAt.getTime() + definition.defaultTtlDays * 86_400_000);
      return {
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
      };
    }),
  );

  const links = toInsert.filter(
    (entry): entry is { draft: FactDraft; id: string; supersedes: string } =>
      entry.supersedes !== null,
  );
  if (links.length > 0) {
    /*
     * The column name is taken from the Drizzle definition, NOT written literally.
     *
     * `facts.superseded` is a TypeScript alias for the column `superseded_by`, and raw SQL sees
     * only the real name. Hand-writing `SET superseded = …` here failed on every chunk that had
     * anything to supersede — and because the chunk fallback swallowed the reason, the symptom
     * was not an error but a batched path that quietly performed no better than the sequential
     * one it replaced. Deriving the name means a future rename cannot reintroduce that.
     */
    const supersededColumn = getTableColumns(facts).superseded.name;
    const tuples = links.map((entry) => sql`(${entry.supersedes}::uuid, ${entry.id}::uuid)`);
    await tx.execute(sql`
      UPDATE ${facts}
      SET ${sql.identifier(supersededColumn)} = v.new_id
      FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(old_id, new_id)
      WHERE ${facts.id} = v.old_id
    `);
  }

  created += toInsert.length;
  superseded += links.length;
  return { created, skipped, superseded };
}
