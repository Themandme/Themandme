import { facts, sources } from '@magnolia/db';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from './record-fact.js';

/**
 * Provenance lookup — the service-layer surface for AT-1.
 *
 * AT-1: "For every fact rendered anywhere in the dashboard, GET /facts/:id returns source,
 * timestamp, confidence, and epistemic level. No fact is orphaned."
 *
 * The HTTP route is M8; this is the function it will wrap. Because `facts.source_id` is
 * NOT NULL and the join is on a foreign key, a fact that resolves at all resolves completely —
 * the "orphaned fact" case is unrepresentable rather than merely untested.
 */

export interface FactProvenance {
  factId: string;
  predicate: string;
  subjectType: string;
  subjectId: string;
  value: unknown;
  /** fact | prediction | inference. Set by the producer; never changes (spec §4.1 rule 3). */
  epistemic: string;
  confidence: number;
  /** When it was true in the world. */
  observedAt: Date;
  /** When Magnolia learned it. */
  recordedAt: Date;
  expiresAt: Date | null;
  source: { id: string; key: string; tier: string; displayName: string };
  isCurrent: boolean;
  supersededBy: string | null;
  derivedFrom: string[] | null;
  costCents: number;
}

export async function getFactProvenance(
  tx: DbOrTx,
  factId: string,
): Promise<FactProvenance | undefined> {
  const [row] = await tx
    .select({
      factId: facts.id,
      predicate: facts.predicate,
      subjectType: facts.subjectType,
      subjectId: facts.subjectId,
      value: facts.value,
      epistemic: facts.epistemic,
      confidence: facts.confidence,
      observedAt: facts.observedAt,
      recordedAt: facts.recordedAt,
      expiresAt: facts.expiresAt,
      isCurrent: facts.isCurrent,
      supersededBy: facts.superseded,
      derivedFrom: facts.derivedFrom,
      costCents: facts.costCents,
      sourceId: sources.id,
      sourceKey: sources.key,
      sourceTier: sources.tier,
      sourceDisplayName: sources.displayName,
    })
    .from(facts)
    .innerJoin(sources, eq(facts.sourceId, sources.id))
    .where(eq(facts.id, factId))
    .limit(1);

  if (row === undefined) return undefined;

  return {
    factId: row.factId,
    predicate: row.predicate,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    value: row.value,
    epistemic: row.epistemic,
    confidence: row.confidence,
    observedAt: row.observedAt,
    recordedAt: row.recordedAt,
    expiresAt: row.expiresAt,
    isCurrent: row.isCurrent,
    supersededBy: row.supersededBy,
    derivedFrom: row.derivedFrom,
    costCents: row.costCents,
    source: {
      id: row.sourceId,
      key: row.sourceKey,
      tier: row.sourceTier,
      displayName: row.sourceDisplayName,
    },
  };
}
