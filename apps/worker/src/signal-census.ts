import { loadEnv } from '@magnolia/config';
import { type CurrentFact, evaluateSignals, signalTypes } from '@magnolia/core';
import { closeDb, createDb, facts, properties, sources } from '@magnolia/db';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { createLogger } from './logger.js';

/**
 * Signal census — evaluate the whole registry over every loaded property and report what
 * actually fires.
 *
 * `pnpm signals:census`
 *
 * ## Why this exists
 *
 * The registry's unit tests prove each rule is correct against synthetic facts. They cannot tell
 * you whether a rule is *useful*, and those are different failures with the same symptom.
 *
 * A signal that fires on 90% of the market carries no information — it cannot separate anything
 * from anything. A signal that fires on 0% is either a rule that is wrong or, far more often
 * here, a rule whose source is dead: six of the thirteen signals have no live feed today (see
 * `docs/SOURCE_VERIFICATION.md`). **Those two look identical from a fire rate alone**, so this
 * reports the fact coverage behind each signal beside its fire rate — a signal reading a
 * predicate that has zero facts in the ledger is untested by this data, not disproven by it.
 *
 * That distinction is the whole point. Reading "vacancy.vbn_open: 0.0%" and concluding Baltimore
 * has no vacant buildings would be exactly backwards.
 *
 * Re-run it after each new source lands: the diff in fire rates is what that source bought.
 *
 * Read-only. It writes nothing, which is what makes it safe to run against a live market.
 */

const PROPERTY_CHUNK = 2_000;

interface Tally {
  active: number;
  strengthSum: number;
  /** Strengths kept for the median — the mean alone hides a bimodal signal. */
  strengths: number[];
}

const env = loadEnv(process.env);
const log = createLogger(env.LOG_LEVEL, { app: 'signal-census' });
const db = createDb(env.DATABASE_URL);

const started = Date.now();
const now = new Date();

const tallies = new Map<string, Tally>(
  signalTypes().map((type) => [type, { active: 0, strengthSum: 0, strengths: [] }]),
);
/** Facts seen per predicate, so a silent signal can be told from a rejected one. */
const predicateCounts = new Map<string, number>();

let scanned = 0;
let withAnySignal = 0;
let cursor = '00000000-0000-0000-0000-000000000000';

for (;;) {
  const page = await db
    .select({ id: properties.id, addressNorm: properties.addressNorm })
    .from(properties)
    .where(gt(properties.id, cursor))
    .orderBy(asc(properties.id))
    .limit(PROPERTY_CHUNK);

  const last = page.at(-1);
  if (last === undefined) break;
  cursor = last.id;

  const ids = page.map((row) => row.id);
  const rows = await db
    .select({
      id: facts.id,
      subjectId: facts.subjectId,
      predicate: facts.predicate,
      value: facts.value,
      observedAt: facts.observedAt,
      /* Tier lives on `sources`, not on the fact — §4.2 ranks the SOURCE, and duplicating it
         onto every fact row would let the two drift. `owner.deceased_probable` is the only
         signal that reads it, and it reads it to discount an LLM guess. */
      tier: sources.tier,
    })
    .from(facts)
    .innerJoin(sources, eq(facts.sourceId, sources.id))
    .where(
      and(
        eq(facts.subjectType, 'property'),
        inArray(facts.subjectId, ids),
        eq(facts.isCurrent, true),
      ),
    );

  const byProperty = new Map<string, CurrentFact[]>();
  for (const row of rows) {
    predicateCounts.set(row.predicate, (predicateCounts.get(row.predicate) ?? 0) + 1);
    const bucket = byProperty.get(row.subjectId);
    const fact: CurrentFact = {
      id: row.id,
      predicate: row.predicate,
      value: row.value,
      observedAt: row.observedAt,
      tier: row.tier,
    };
    if (bucket === undefined) byProperty.set(row.subjectId, [fact]);
    else bucket.push(fact);
  }

  for (const property of page) {
    scanned += 1;
    const states = evaluateSignals({
      facts: byProperty.get(property.id) ?? [],
      now,
      propertyAddressNorm: property.addressNorm,
    });
    let any = false;
    for (const [type, state] of states) {
      if (!state.active) continue;
      any = true;
      const tally = tallies.get(type);
      if (tally === undefined) continue;
      tally.active += 1;
      tally.strengthSum += state.strength;
      tally.strengths.push(state.strength);
    }
    if (any) withAnySignal += 1;
  }

  if (page.length < PROPERTY_CHUNK) break;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const pct = (n: number): string => (scanned === 0 ? '0.00' : ((n / scanned) * 100).toFixed(2));

const report = [...tallies.entries()]
  .map(([type, tally]) => ({
    type,
    active: tally.active,
    pct: pct(tally.active),
    meanStrength: tally.active === 0 ? 0 : Number((tally.strengthSum / tally.active).toFixed(3)),
    medianStrength: Number(median(tally.strengths).toFixed(3)),
  }))
  .sort((a, b) => b.active - a.active);

log.info('signal census', {
  properties: scanned,
  withAnySignal,
  withAnySignalPct: pct(withAnySignal),
  seconds: Math.round((Date.now() - started) / 1000),
});

/* Printed rather than logged: this is a table for a human to read, and a JSON log line per row
   is unreadable at thirteen rows. */
console.table(report);
console.table(
  [...predicateCounts.entries()]
    .map(([predicate, count]) => ({ predicate, facts: count }))
    .sort((a, b) => b.facts - a.facts),
);

const silent = report.filter((row) => row.active === 0).map((row) => row.type);
if (silent.length > 0) {
  /* Named explicitly, because a zero row scrolls past and a dead source is the single largest
     risk to signal coverage (README, SOURCE_VERIFICATION.md). */
  log.warn('signals that never fired', { types: silent });
}

await closeDb(db);
