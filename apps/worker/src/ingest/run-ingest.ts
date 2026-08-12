import { createHash } from 'node:crypto';
import {
  loadPredicateRegistry,
  loadResolutionParams,
  projectProperties,
  recordFacts,
  resolveProperties,
  resolveProperty,
  type PredicateRegistry,
  type PropertyRef,
  type ResolutionParams,
} from '@magnolia/core';
import { markets, rawRecords, sourceFetches, sources, type Db } from '@magnolia/db';
import type { AdapterRegistry, DataSourceAdapter } from '@magnolia/providers';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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
  /**
   * Chunks that rolled back and were retried record by record.
   *
   * Surfaced rather than swallowed: a non-empty list with an empty `errors` list means the
   * BATCHED path is broken while the sequential one still works, which is a bug that otherwise
   * shows up only as lost performance.
   */
  chunkFallbacks: { records: number; message: string }[];
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

/**
 * Records folded into one normalize transaction.
 *
 * The ceiling is the batched fact insert: 500 records x 7 facts x ~14 bound columns is well
 * inside Postgres's 65,535 parameter limit, while cutting round trips by two orders of
 * magnitude. It is also the unit of retry — a chunk that fails is redone one record at a time,
 * so a larger chunk means a more expensive failure.
 */
export const NORMALIZE_CHUNK_SIZE = 500;

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
  const chunkFallbacks: { records: number; message: string }[] = [];
  const touched = new Set<string>();

  type PendingRecord = (typeof pending)[number];

  /**
   * Normalize one record on its own, in its own transaction.
   *
   * This is the fallback the chunked path drops to when a chunk fails, and it is what preserves
   * the property that matters most here: **one malformed record must not cost the other 499**.
   * A chunk is one transaction, so a single bad record would otherwise roll back and re-mark all
   * of its neighbours as pending, and the run would never make progress.
   */
  const normalizeOne = async (record: PendingRecord): Promise<void> => {
    try {
      await db.transaction(async (tx) => {
        const produced = adapter.normalize({
          sourceKey: adapter.key,
          sourceRecordId: record.sourceRecordId,
          payload: record.payload as Record<string, unknown>,
          observedAt: record.observedAt,
        });

        const resolvedBySubject = new Map<string, string>();
        const drafts: Parameters<typeof recordFacts>[2][number][] = [];

        for (const fact of produced) {
          const subjectKey = JSON.stringify(fact.subject);
          let propertyId = resolvedBySubject.get(subjectKey);
          if (propertyId === undefined) {
            const resolved = await resolveProperty(tx, fact.subject, { marketId, ...resolution });
            if (resolved.created) propertiesCreated += 1;
            else propertiesMatched += 1;
            propertyId = resolved.propertyId;
            resolvedBySubject.set(subjectKey, propertyId);
          }
          touched.add(propertyId);

          drafts.push({
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
        }

        const outcome = await recordFacts(tx, registry, drafts);
        factsWritten += outcome.created;

        await tx
          .update(rawRecords)
          .set({ normalizedAt: new Date(), normalizeError: null })
          .where(eq(rawRecords.id, record.id));
      });
      normalized += 1;
    } catch (error) {
      /* Stays pending with the reason recorded, so a fix plus a re-run picks it up rather than
         requiring a re-fetch. */
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ rawRecordId: record.id, message });
      await db
        .update(rawRecords)
        .set({ normalizeError: message })
        .where(eq(rawRecords.id, record.id));
    }
  };

  /**
   * Normalize a chunk in a single transaction, sharing every lookup across it.
   *
   * Per record the sequential path costs about eighteen round trips: a resolve cascade plus two
   * per fact, and SDAT emits seven facts per record. Measured on the live 237,260-parcel load
   * that ran at 3,324 records/min — roughly 70 minutes.
   *
   * Chunked, the same work is a handful of statements for the whole chunk: two resolve lookups,
   * one source lookup, one current-fact lookup, three fact writes, one raw-record update.
   *
   * Returns false if the chunk failed, so the caller can retry it record by record.
   */
  const normalizeChunk = async (chunk: readonly PendingRecord[]): Promise<boolean> => {
    try {
      await db.transaction(async (tx) => {
        /* Normalize first — pure, no I/O — so the whole chunk's references are known before a
           single query runs. */
        const produced = chunk.map((record) => ({
          record,
          facts: adapter.normalize({
            sourceKey: adapter.key,
            sourceRecordId: record.sourceRecordId,
            payload: record.payload as Record<string, unknown>,
            observedAt: record.observedAt,
          }),
        }));

        /* One entry per DISTINCT subject across the chunk. Several records routinely name the
           same property, and the same record names one subject in every fact it produces. */
        const refIndex = new Map<string, number>();
        const refs: PropertyRef[] = [];
        for (const { facts: produced_ } of produced) {
          for (const fact of produced_) {
            const key = JSON.stringify(fact.subject);
            if (!refIndex.has(key)) {
              refIndex.set(key, refs.length);
              refs.push(fact.subject);
            }
          }
        }

        const resolved = await resolveProperties(tx, refs, { marketId, ...resolution });
        propertiesCreated += resolved.created;
        propertiesMatched += resolved.matched;

        const drafts: Parameters<typeof recordFacts>[2][number][] = [];
        for (const { record, facts: produced_ } of produced) {
          for (const fact of produced_) {
            const index = refIndex.get(JSON.stringify(fact.subject));
            const propertyId = index === undefined ? undefined : resolved.byIndex.get(index);
            if (propertyId === undefined) {
              throw new Error(`resolution produced no property for a subject in ${record.id}`);
            }
            touched.add(propertyId);
            drafts.push({
              subjectType: 'property',
              subjectId: propertyId,
              predicate: fact.predicate,
              value: fact.value,
              epistemic: fact.epistemic,
              sourceId,
              ...(record.sourceRecordId === null ? {} : { sourceRecordId: record.sourceRecordId }),
              rawRecordId: record.id,
              observedAt: fact.observedAt,
              confidence: fact.confidence,
            });
          }
        }

        const outcome = await recordFacts(tx, registry, drafts);
        factsWritten += outcome.created;

        await tx
          .update(rawRecords)
          .set({ normalizedAt: new Date(), normalizeError: null })
          .where(
            inArray(
              rawRecords.id,
              chunk.map((record) => record.id),
            ),
          );
      });
      normalized += chunk.length;
      return true;
    } catch (error) {
      /*
       * Falling back is expected — one bad record in a chunk of 500 rolls the chunk back, and the
       * per-record retry is how the other 499 still land. Falling back SILENTLY is not: a bug in
       * the batched path would then present as "no faster than before" rather than as an error,
       * which is exactly what a mistyped column name did here.
       *
       * Recorded against the chunk rather than a record, because at this point it is not known
       * which record is at fault — the per-record retry below is what determines that.
       */
      chunkFallbacks.push({
        records: chunk.length,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  for (let offset = 0; offset < pending.length; offset += NORMALIZE_CHUNK_SIZE) {
    const chunk = pending.slice(offset, offset + NORMALIZE_CHUNK_SIZE);

    /* Snapshot the counters. A failed chunk rolls back in the database but not in these, and
       the increments it made describe work that no longer exists — so they are rewound to
       exactly this point rather than reset, which would also discard every earlier chunk. */
    const createdBefore = propertiesCreated;
    const matchedBefore = propertiesMatched;
    const factsBefore = factsWritten;

    if (await normalizeChunk(chunk)) continue;

    propertiesCreated = createdBefore;
    propertiesMatched = matchedBefore;
    factsWritten = factsBefore;

    /* Redo one record at a time: the survivors land, and the offender is recorded against its
       own id rather than taking its 499 neighbours down with it. */
    for (const record of chunk) await normalizeOne(record);
  }

  /* Project once per property rather than per fact — the read model is a pure function of
     current facts, so intermediate projections would be wasted work.

     Batched: the per-property path costs one query per projectable column plus an UPDATE, so a
     VBN load spent ~138,000 round trips here and most of its wall clock. `projectProperties`
     does two queries per 500 properties instead. */
  await projectProperties(db, registry, [...touched]);

  return { normalized, factsWritten, propertiesCreated, propertiesMatched, errors, chunkFallbacks };
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
