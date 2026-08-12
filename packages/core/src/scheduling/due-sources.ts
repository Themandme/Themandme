import { featureFlags, sources } from '@magnolia/db';
import { CronExpressionParser } from 'cron-parser';
import type { DbOrTx } from '../facts/record-fact.js';

/**
 * Which sources are due to be fetched. BUILD_PLAN M2.1.
 *
 * Lives in `packages/core` rather than in the worker so it is testable **without Redis**, the
 * same split `publishBatch` / `createPublisher` already uses: the decision is here, the queue
 * client is wiring.
 *
 * ## Why this classifies rather than filters
 *
 * The obvious signature is `dueSources() => string[]`. It is the wrong one, because it collapses
 * three very different situations into one absence:
 *
 *   - the source is not due yet;
 *   - the source has no schedule at all;
 *   - the source is **refused** — disabled, kill-switched, or ToS-restricted.
 *
 * `registry.requireRunnable` throws for the third case precisely so that "refused" and "found
 * nothing" cannot look alike, and a scheduler that silently dropped refused sources from a list
 * would reintroduce exactly that ambiguity one layer up.
 *
 * It does **not** throw, though, and that is deliberate: on day one every external source is
 * seeded `enabled: false` (invariant 8), so throwing would mean sixteen exceptions on every
 * sweep for a system behaving exactly as designed. A kill switch that is off is not an error.
 * The requirement is that an operator can *see* the difference, so the difference is returned.
 *
 * ## Due is computed from `last_success_at`, not from a stored next-run
 *
 * Storing a next-run timestamp would drift: a worker that was down over a scheduled window
 * would either skip the run entirely or need catch-up logic. Deriving the next fire time from
 * the cron expression anchored at the last success means a source that missed its window is
 * simply due now, which is the behaviour wanted for a daily property-data refresh.
 */

export type SourceScheduleStatus =
  | { status: 'due'; dueSince: Date }
  | { status: 'not_due'; nextDueAt: Date }
  /** `refresh_cron` is null — internal producers and manual-upload sources. */
  | { status: 'unscheduled' }
  /** Refused. Mirrors `SourceDisabledError.reason` so the two vocabularies stay one. */
  | { status: 'refused'; reason: 'disabled' | 'scraping_not_allowed' | 'flag_off' }
  /** The cron expression in the seed does not parse. A configuration bug, surfaced not skipped. */
  | { status: 'invalid_schedule'; detail: string };

export interface SourceSchedule {
  key: string;
  sourceId: string;
  state: SourceScheduleStatus;
}

/**
 * Classify every source against the clock.
 *
 * `now` is a parameter rather than read from the clock so the result is testable and so a sweep
 * cannot disagree with itself midway through.
 */
export async function classifySources(db: DbOrTx, now: Date): Promise<SourceSchedule[]> {
  const rows = await db
    .select({
      id: sources.id,
      key: sources.key,
      enabled: sources.enabled,
      scrapingAllowed: sources.scrapingAllowed,
      refreshCron: sources.refreshCron,
      lastSuccessAt: sources.lastSuccessAt,
    })
    .from(sources);

  const flags = await db
    .select({ key: featureFlags.key, enabled: featureFlags.enabled })
    .from(featureFlags);
  const flagByKey = new Map(flags.map((flag) => [flag.key, flag.enabled]));

  return rows.map((row) => ({
    key: row.key,
    sourceId: row.id,
    state: classify(row, flagByKey, now),
  }));
}

interface SourceRow {
  key: string;
  enabled: boolean;
  scrapingAllowed: boolean;
  refreshCron: string | null;
  lastSuccessAt: Date | null;
}

function classify(
  row: SourceRow,
  flagByKey: Map<string, boolean>,
  now: Date,
): SourceScheduleStatus {
  /*
   * Refusal is checked before scheduling, and in the same order as `requireRunnable`, so the
   * scheduler and the guard can never disagree about *why* a source will not run. The legal
   * constraint is checked first: a ToS-restricted source must read as ToS-restricted even if it
   * also happens to be disabled, because that is the reason that must not be "fixed" by flipping
   * a flag (spec §4.5, §17.6).
   */
  if (!row.scrapingAllowed) return { status: 'refused', reason: 'scraping_not_allowed' };
  if (!row.enabled) return { status: 'refused', reason: 'disabled' };
  /* A missing flag is off. Invariant 8: absence is not permission. */
  if (flagByKey.get(`source.${row.key}`) !== true) {
    return { status: 'refused', reason: 'flag_off' };
  }

  if (row.refreshCron === null) return { status: 'unscheduled' };

  try {
    /*
     * `dueSince` must identify the WINDOW, not the moment of asking.
     *
     * The scheduler derives its BullMQ job id from this value so that a sweep running every
     * minute enqueues one job per cron window rather than one per sweep. Returning `now` for a
     * never-fetched source breaks exactly that: the value differs on every sweep, so every sweep
     * mints a new job id and the deduplication silently stops working — 1,440 jobs a day for a
     * daily source. It is the one case where the obvious answer ("it has never run, so it is due
     * right now") produces an unstable identifier.
     *
     * So both branches name a scheduled instant instead:
     *
     *   - never fetched → the most recent fire time at or before now. Still "due immediately",
     *     because that instant has passed, but stable for the whole window.
     *   - fetched       → the first fire time after the last success.
     */
    if (row.lastSuccessAt === null) {
      const previous = CronExpressionParser.parse(row.refreshCron, { currentDate: now, tz: 'UTC' })
        .prev()
        .toDate();
      return { status: 'due', dueSince: previous };
    }

    const next = CronExpressionParser.parse(row.refreshCron, {
      currentDate: row.lastSuccessAt,
      tz: 'UTC',
    })
      .next()
      .toDate();
    return next.getTime() <= now.getTime()
      ? { status: 'due', dueSince: next }
      : { status: 'not_due', nextDueAt: next };
  } catch (error) {
    /*
     * A cron expression that does not parse is a seed bug. Reporting it as "not due" would hide
     * a source that then never runs again and never explains why — the quiet failure this
     * codebase keeps finding in its data sources, reproduced in its own configuration.
     */
    return {
      status: 'invalid_schedule',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The subset a sweep should actually enqueue. */
export function dueNow(schedules: readonly SourceSchedule[]): SourceSchedule[] {
  return schedules.filter((schedule) => schedule.state.status === 'due');
}

/** One-line-per-source summary, for the operator-facing sweep log. */
export function formatSchedule(schedules: readonly SourceSchedule[]): string {
  return schedules
    .map((schedule) => {
      const state = schedule.state;
      const detail =
        state.status === 'due'
          ? `due since ${state.dueSince.toISOString()}`
          : state.status === 'not_due'
            ? `next ${state.nextDueAt.toISOString()}`
            : state.status === 'refused'
              ? `REFUSED (${state.reason})`
              : state.status === 'invalid_schedule'
                ? `INVALID CRON — ${state.detail}`
                : 'no schedule';
      return `${schedule.key.padEnd(28)} ${state.status.padEnd(17)} ${detail}`;
    })
    .join('\n');
}
