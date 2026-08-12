import { createHash } from 'node:crypto';
import {
  loadPredicateRegistry,
  loadResolutionParams,
  projectProperty,
  recordFact,
  resolveProperty,
  type PredicateRegistry,
  type ResolutionParams,
} from '@magnolia/core';
import { markets, rawRecords, sourceFetches, sources, type Db } from '@magnolia/db';
import type { AdapterRegistry, DataSourceAdapter } from '@magnolia/providers';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

/**
 * Ingestion pipeline. BUILD_PLAN M2.
 *
 * Lives here rather than in `packages/core` because `providers` already depends on `core` —
 * orchestration in core would make the workspace dependency circular. It also matches spec
 * §3.1, which puts processors and schedulers in the worker.
 *
 * Two phases, deliberately separate:
 *
 *   1. FETCH banks raw payloads in `raw_records` and closes a `source_fetches` row.
 *   2. NORMALIZE processes `raw_records WHERE normalized_at IS NULL`.
 *
 * The split is what makes the job **resumable**. A crash between the phases leaves the payloads
 * banked, and the next run finishes them instead of re-fetching. Doing both in one pass would
 * either lose an expensive fetch on a normalizer bug, or — worse — mark records normalized that
 * were not, silently dropping them forever.
 *
 * Idempotency (invariant 7, AT-2) comes from three mechanisms that already exist rather than a
 * fourth invented here: `raw_records_dedupe` stops an unchanged payload being banked twice,
 * `recordFact` short-circuits an identical write, and `facts_one_current_per_source` makes a
 * second current fact from one source impossible.
 */

export interface IngestReport {
  sourceKey: string;
  fetched: number;
  /** Payloads new to `raw_records`; the rest were already banked. */
  banked: number;
  normalized: number;
  factsWritten: number;
  propertiesCreated: number;
  propertiesMatched: number;
  errors: { rawRecordId: string; message: string }[];
}

/** Stable hash of a payload: key order from the service must not create a false new record. */
export function payloadHash(payload: Record<string, unknown>): Buffer {
  return createHash('sha256')
    .update(JSON.stringify(canonical(payload)))
    .digest();
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

async function marketIdForSource(db: Db, sourceKey: string): Promise<string> {
  const [row] = await db
    .select({ marketId: sources.marketId })
    .from(sources)
    .where(eq(sources.key, sourceKey))
    .limit(1);

  if (row?.marketId != null) return row.marketId;

  /* Internal producers are market-agnostic; an external adapter without a market is a seed
     bug, and guessing a market would silently file Baltimore data under the wrong one. */
  const [baltimore] = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.key, 'baltimore_city_md'))
    .limit(1);
  if (baltimore === undefined) {
    throw new Error(`No market for source "${sourceKey}" and no baltimore_city_md market seeded.`);
  }
  return baltimore.id;
}

/** Phase 1 — bank raw payloads. Returns the fetch row id. */
export async function fetchIntoRawRecords(
  db: Db,
  adapter: DataSourceAdapter,
  sourceId: string,
  signal: AbortSignal,
): Promise<{ fetchId: string; fetched: number; banked: number }> {
  const fetchId = uuidv7();
  await db.insert(sourceFetches).values({ id: fetchId, sourceId });

  let fetched = 0;
  let banked = 0;
  let failure: string | null = null;

  try {
    for await (const raw of adapter.fetch(null, signal)) {
      fetched += 1;
      const inserted = await db
        .insert(rawRecords)
        .values({
          id: uuidv7(),
          fetchId,
          sourceId,
          sourceRecordId: raw.sourceRecordId,
          payload: raw.payload,
          payloadHash: payloadHash(raw.payload),
          observedAt: raw.observedAt,
        })
        .onConflictDoNothing()
        .returning({ id: rawRecords.id });
      if (inserted.length > 0) banked += 1;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await db
      .update(sourceFetches)
      .set({
        finishedAt: new Date(),
        recordCount: fetched,
        ok: failure === null,
        ...(failure === null ? {} : { error: failure }),
      })
      .where(eq(sourceFetches.id, fetchId));

    /* `last_success_at` reflects a successful FETCH only. It says nothing about whether the
       source produced anything new — the Baltimore foreclosure layer answers 200 with an empty
       delta and has done since 2020. Freshness is a separate check; see docs/SOURCE_VERIFICATION.md. */
    await db
      .update(sources)
      .set(
        failure === null
          ? { lastSuccessAt: new Date() }
          : { lastErrorAt: new Date(), lastError: failure },
      )
      .where(eq(sources.id, sourceId));
  }

  return { fetchId, fetched, banked };
}

/** Phase 2 — normalize everything still pending for a source. Resumable. */
export async function normalizePending(
  db: Db,
  adapter: DataSourceAdapter,
  sourceId: string,
  registry: PredicateRegistry,
  marketId: string,
  resolution: ResolutionParams,
): Promise<Omit<IngestReport, 'sourceKey' | 'fetched' | 'banked'>> {
  const pending = await db
    .select()
    .from(rawRecords)
    .where(and(eq(rawRecords.sourceId, sourceId), isNull(rawRecords.normalizedAt)));

  let normalized = 0;
  let factsWritten = 0;
  let propertiesCreated = 0;
  let propertiesMatched = 0;
  const errors: { rawRecordId: string; message: string }[] = [];
  const touched = new Set<string>();

  for (const record of pending) {
    try {
      await db.transaction(async (tx) => {
        const facts = adapter.normalize({
          sourceKey: adapter.key,
          sourceRecordId: record.sourceRecordId,
          payload: record.payload as Record<string, unknown>,
          observedAt: record.observedAt,
        });

        /*
         * One resolution per SUBJECT, not per fact.
         *
         * Adapters emit several facts about the same property from one record — VBN emits two,
         * SDAT eight — and every one of them carried the identical `PropertyRef` through the
         * full tier-1/tier-2/tier-3 cascade. Measured on a real VBN load: 11,536 records
         * produced 23,072 resolutions, exactly 2.00 per record, all but 11,536 of them
         * redundant. On SDAT's 222,703 Baltimore parcels that multiplier is eight.
         *
         * The memo is scoped to this record, inside this transaction, so it cannot serve a
         * stale id across records and does not change what gets written — only how many times
         * the same question is asked.
         */
        const resolvedBySubject = new Map<string, string>();

        for (const fact of facts) {
          const subjectKey = JSON.stringify(fact.subject);
          const memoised = resolvedBySubject.get(subjectKey);

          let propertyId: string;
          if (memoised !== undefined) {
            propertyId = memoised;
          } else {
            const resolved = await resolveProperty(tx, fact.subject, { marketId, ...resolution });
            if (resolved.created) propertiesCreated += 1;
            else propertiesMatched += 1;
            propertyId = resolved.propertyId;
            resolvedBySubject.set(subjectKey, propertyId);
          }
          touched.add(propertyId);

          const written = await recordFact(tx, registry, {
            subjectType: 'property',
            subjectId: propertyId,
            predicate: fact.predicate,
            value: fact.value,
            epistemic: fact.epistemic,
            sourceId,
            /* exactOptionalPropertyTypes: an optional property must be absent, not explicitly
               undefined, so this spreads conditionally rather than passing undefined. */
            ...(record.sourceRecordId === null ? {} : { sourceRecordId: record.sourceRecordId }),
            rawRecordId: record.id,
            observedAt: fact.observedAt,
            confidence: fact.confidence,
          });
          if (written.created) factsWritten += 1;
        }

        await tx
          .update(rawRecords)
          .set({ normalizedAt: new Date(), normalizeError: null })
          .where(eq(rawRecords.id, record.id));
      });
      normalized += 1;
    } catch (error) {
      /* One malformed record must not abort the batch — but it also must not be marked
         normalized. It stays pending with the reason recorded, so a fix plus a re-run picks it
         up rather than requiring a re-fetch. */
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ rawRecordId: record.id, message });
      await db
        .update(rawRecords)
        .set({ normalizeError: message })
        .where(eq(rawRecords.id, record.id));
    }
  }

  /* Project once per property rather than per fact — the read model is a pure function of
     current facts, so intermediate projections would be wasted work. */
  for (const propertyId of touched) {
    await projectProperty(db, registry, propertyId);
  }

  return { normalized, factsWritten, propertiesCreated, propertiesMatched, errors };
}

/**
 * Run one source end to end.
 *
 * The registry decides whether the adapter may run at all; a disabled or non-scrapable source
 * throws here rather than returning an empty report, because "refused" and "found nothing" must
 * not look the same to a caller.
 */
export async function ingestSource(
  db: Db,
  registryOfAdapters: AdapterRegistry,
  sourceKey: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<IngestReport> {
  const adapter = await registryOfAdapters.requireRunnable(db, sourceKey);

  const [sourceRow] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.key, sourceKey))
    .limit(1);
  if (sourceRow === undefined) throw new Error(`source "${sourceKey}" vanished mid-run`);

  const marketId = await marketIdForSource(db, sourceKey);
  const predicates = await loadPredicateRegistry(db);
  /* Read once per run, not once per record. These come from the market row with no code-level
     fallback (CLAUDE.md: market parameters live in config/), so a market seeded without them
     fails the run here rather than resolving at some compiled-in threshold. */
  const resolution = await loadResolutionParams(db, marketId);

  const { fetched, banked } = await fetchIntoRawRecords(db, adapter, sourceRow.id, signal);
  const rest = await normalizePending(db, adapter, sourceRow.id, predicates, marketId, resolution);

  return { sourceKey, fetched, banked, ...rest };
}

/** Per-source record counts, the report BUILD_PLAN M2's DoD asks for. */
export function formatReport(reports: IngestReport[]): string {
  const lines = reports.map(
    (r) =>
      `${r.sourceKey.padEnd(28)} fetched=${String(r.fetched).padStart(6)} ` +
      `banked=${String(r.banked).padStart(6)} normalized=${String(r.normalized).padStart(6)} ` +
      `facts=${String(r.factsWritten).padStart(6)} ` +
      `props(new/matched)=${String(r.propertiesCreated)}/${String(r.propertiesMatched)}` +
      (r.errors.length > 0 ? `  ERRORS=${String(r.errors.length)}` : ''),
  );
  return lines.join('\n');
}

export { sql };
