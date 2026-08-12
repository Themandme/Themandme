import { loadPredicateRegistry, loadResolutionParams, type NormalizedFact } from '@magnolia/core';
import { markets, rawRecords, sourceFetches, sources, type Db } from '@magnolia/db';
import type { RawRecord } from '@magnolia/providers';
import { parse } from 'csv-parse/sync';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { normalizePending, payloadHash, type IngestReport } from './run-ingest.js';

/**
 * Manual upload. BUILD_PLAN M2.6.
 *
 * CSV → `raw_records` → **the same normalizer** an automated source would use. Reusing the
 * normalizer is the point rather than a convenience: a hand-uploaded fact has to be as
 * traceable, as replayable and as conflict-resolvable as a fetched one, and a second write path
 * would produce facts that replay differently (§13.3).
 *
 * ## This path deliberately does NOT require `scraping_allowed`
 *
 * That looks like a hole and is the opposite. Spec §4.5 keeps `md.case_search` and
 * `md.land_records` non-scrapable, and says in the same breath that they are "reachable only by
 * **manual operator lookup**". Manual upload *is* the permitted route for exactly those sources,
 * so requiring `scraping_allowed` here would forbid the one thing §4.5 allows.
 *
 * What it requires instead is an **operator**: `uploadedBy` is mandatory and is recorded, so
 * every fact that arrives this way names the person who put it there. Automated access is
 * refused by `registry.requireRunnable`; this path is refused if nobody signs for it.
 *
 * ## Provenance is an explicit choice, because the two cases resolve conflicts differently
 *
 * §4.2 ranks `human` as the HIGHEST authority — `human: 0` in the resolver — so a fact recorded
 * against `magnolia.human` beats every automated source, permanently. That is right for what
 * §4.5 describes: an operator looks up one case by hand and records what they read.
 *
 * It is badly wrong for a nine-thousand-row transcription of a tax-sale document. Landing that
 * as tier `human` would mean every transcribed row outranks SDAT forever, and a single typo in
 * the file could never be corrected by any automated source — the fix would itself have to be
 * manual, in perpetuity.
 *
 * So the caller must say which it is, and there is no default: choosing wrong is silent, and the
 * damage is discovered much later.
 */

export type ManualProvenance =
  /**
   * An operator's own observation or lookup — §4.5 manual lookup, or a correction. Recorded
   * against `magnolia.human`, tier `human`, and therefore outranks every automated source.
   */
  | 'operator'
  /**
   * A bulk transcription of a document the named source published. Recorded against that
   * source's own row, so it keeps the source's tier for §4.2 resolution and can still be
   * corrected by that source's automated feed later. Confidence is discounted for
   * transcription risk.
   */
  | 'transcribed';

export interface ManualUploadOptions {
  /** The dataset this content belongs to, e.g. `baltimore.tax_sale`. Always required. */
  sourceKey: string;
  /** Raw CSV text. Header row required — column names become payload keys. */
  csv: string;
  /** Operator identifier. Mandatory: an unsigned manual upload is not accepted. */
  uploadedBy: string;
  provenance: ManualProvenance;
  /** Where the content came from — a filename or URL. Recorded on the fetch row. */
  origin: string;
  /** When the SOURCE observed this, not when it was uploaded. */
  observedAt: Date;
  /** Same contract as an adapter's: pure and synchronous (spec §9.1). */
  normalize: (raw: RawRecord) => NormalizedFact[];
}

export class ManualUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualUploadError';
  }
}

/**
 * The adapter shape requires a `fetch`, but `normalizePending` only reads already-banked rows,
 * so this is never called. Defined as a real (empty) async generator rather than a throwing stub:
 * an unreachable throw becomes a landmine if the call path ever changes, whereas yielding nothing
 * is correct under any caller.
 */
async function* emptyFetch(): AsyncGenerator<RawRecord> {
  /* intentionally empty */
}

/** Multiplied into each fact's confidence when `provenance === 'transcribed'`. */
export const TRANSCRIPTION_CONFIDENCE_FACTOR = 0.9;

type CsvRow = Record<string, string>;

/** Parse CSV strictly. A malformed file must fail, not silently yield fewer rows. */
export function parseCsv(csv: string): CsvRow[] {
  try {
    return parse(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      /* Ragged rows mean the file is not what the uploader thinks it is. Accepting them would
         produce facts from misaligned columns, which is worse than rejecting the upload. */
      relax_column_count: false,
      bom: true,
    });
  } catch (error) {
    throw new ManualUploadError(
      `CSV could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Ingest an operator-supplied CSV.
 *
 * Returns the same `IngestReport` shape an automated run does, so a manual load appears in the
 * per-source record-count report M2's DoD asks for rather than in a separate one.
 */
export async function ingestManualUpload(
  db: Db,
  options: ManualUploadOptions,
): Promise<IngestReport> {
  if (options.uploadedBy.trim() === '') {
    throw new ManualUploadError(
      'uploadedBy is required: a manual upload must name the operator who supplied it, ' +
        'because the resulting facts carry human provenance and nothing else records who.',
    );
  }

  const [originating] = await db
    .select({ id: sources.id, key: sources.key, marketId: sources.marketId })
    .from(sources)
    .where(eq(sources.key, options.sourceKey))
    .limit(1);
  if (originating === undefined) {
    throw new ManualUploadError(
      `No \`sources\` row for "${options.sourceKey}". facts.source_id is NOT NULL, so every ` +
        `fact from this upload would be unprovenanced. Seed the source first.`,
    );
  }

  /* Which row the FACTS hang off — see the provenance note in the header. The originating
     source is recorded either way, on the fetch row and in every payload, so a `magnolia.human`
     fact can still be traced back to the document it was transcribed from. */
  let factSourceId = originating.id;
  if (options.provenance === 'operator') {
    const [human] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.key, 'magnolia.human'))
      .limit(1);
    if (human === undefined) {
      throw new ManualUploadError(
        'No `magnolia.human` source row. The seed creates it; run the seed before uploading.',
      );
    }
    factSourceId = human.id;
  }

  const rows = parseCsv(options.csv);
  if (rows.length === 0) {
    throw new ManualUploadError('CSV contained a header but no data rows.');
  }

  const fetchId = uuidv7();
  await db.insert(sourceFetches).values({
    id: fetchId,
    sourceId: factSourceId,
    finishedAt: new Date(),
    recordCount: rows.length,
    ok: true,
    /* The audit trail for a manual load: who, from where, for which dataset. */
    storageUri: `manual-upload:${options.provenance}:${originating.key}:${options.origin}:${options.uploadedBy}`,
  });

  let banked = 0;
  for (const row of rows) {
    const payload: Record<string, unknown> = {
      ...row,
      /* Envelope, namespaced like the adapters' `__centroid` so it cannot collide with a CSV
         column name. This is what lets a human-tier fact still say which document it came from. */
      __upload: {
        uploadedBy: options.uploadedBy,
        origin: options.origin,
        provenance: options.provenance,
        originatingSourceKey: originating.key,
      },
    };

    const inserted = await db
      .insert(rawRecords)
      .values({
        id: uuidv7(),
        fetchId,
        sourceId: factSourceId,
        sourceRecordId: null,
        payload,
        payloadHash: payloadHash(payload),
        observedAt: options.observedAt,
      })
      /* Same dedupe as an automated fetch (invariant 7): re-uploading an identical file banks
         nothing new, so a nervous operator uploading twice does not double the facts. */
      .onConflictDoNothing()
      .returning({ id: rawRecords.id });
    if (inserted.length > 0) banked += 1;
  }

  const marketId = await marketIdFor(db, originating.marketId);
  const predicates = await loadPredicateRegistry(db);
  const resolution = await loadResolutionParams(db, marketId);

  const normalize =
    options.provenance === 'transcribed'
      ? discountConfidence(options.normalize, TRANSCRIPTION_CONFIDENCE_FACTOR)
      : options.normalize;

  const rest = await normalizePending(
    db,
    {
      key: originating.key,
      tier: 'human',
      scrapingAllowed: false,
      costModel: { perCallCents: 0, monthlyCents: 0 },
      fetch: () => emptyFetch(),
      normalize,
      healthCheck: () =>
        Promise.resolve({ ok: true, detail: 'manual upload', checkedAt: new Date() }),
    },
    factSourceId,
    predicates,
    marketId,
    resolution,
  );

  return { sourceKey: originating.key, fetched: rows.length, banked, ...rest };
}

/**
 * Wrap a normalizer so its facts carry a reduced confidence.
 *
 * Transcription is lossy in a way an API response is not — a misread digit in a house number is
 * a different property. The tier still says the data is an official record, which is true; the
 * confidence says we are slightly less sure it was copied correctly, which is also true.
 */
function discountConfidence(
  normalize: (raw: RawRecord) => NormalizedFact[],
  factor: number,
): (raw: RawRecord) => NormalizedFact[] {
  return (raw) => normalize(raw).map((fact) => ({ ...fact, confidence: fact.confidence * factor }));
}

async function marketIdFor(db: Db, sourceMarketId: string | null): Promise<string> {
  if (sourceMarketId !== null) return sourceMarketId;
  const [baltimore] = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.key, 'baltimore_city_md'))
    .limit(1);
  if (baltimore === undefined) {
    throw new ManualUploadError('No market for this source and no baltimore_city_md seeded.');
  }
  return baltimore.id;
}
