import { featureFlags, seed, sources, type Db } from '@magnolia/db';
import { createTestDb, type TestDb } from '@magnolia/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifySources, dueNow, formatSchedule } from '../due-sources.js';

/**
 * Scheduling. BUILD_PLAN M2.1.
 *
 * No Redis anywhere in this file — that is the point of keeping the decision in `core`. What
 * BullMQ does with the answer is wiring, and wiring that cannot change whether a ToS-restricted
 * source gets fetched.
 */

let harness: TestDb | undefined;
let db: Db;

/** A source's state as an operator would set it: the row and the kill switch, both. */
async function enable(key: string): Promise<void> {
  await db.update(sources).set({ enabled: true }).where(eq(sources.key, key));
  await db
    .update(featureFlags)
    .set({ enabled: true })
    .where(eq(featureFlags.key, `source.${key}`));
}

async function stateOf(key: string, now: Date) {
  const all = await classifySources(db, now);
  const found = all.find((schedule) => schedule.key === key);
  if (found === undefined) throw new Error(`no schedule for ${key}`);
  return found.state;
}

const NOW = new Date('2026-08-12T12:00:00Z');

beforeAll(async () => {
  harness = await createTestDb('scheduling');
  db = harness.db;
  await seed(db);
}, 60_000);

afterAll(async () => {
  if (harness !== undefined) await harness.drop();
});

beforeEach(async () => {
  /* Re-seed rather than UPDATE back to false. One test below DELETES a flag row to prove that a
     missing flag reads as off, and an UPDATE-only reset cannot restore a deleted row — it would
     leave every later test silently refused for the wrong reason. `seed` upserts and is
     idempotent, so it restores the row and the posture together. */
  await seed(db);
  await db.update(sources).set({ enabled: false, lastSuccessAt: null });
  await db.update(featureFlags).set({ enabled: false });
});

describe('refusal is reported, never silently filtered', () => {
  it('reports a seeded-disabled source as refused, not as "not due"', async () => {
    /* Invariant 8 means this is the day-one state of every external source. A scheduler that
       merely omitted them would be indistinguishable from one where nothing happened to be due,
       and an operator would have no way to tell why the load never ran. */
    expect(await stateOf('baltimore.vbn', NOW)).toEqual({ status: 'refused', reason: 'disabled' });
  });

  it('reports flag_off when the row is on but the kill switch is not', async () => {
    await db.update(sources).set({ enabled: true }).where(eq(sources.key, 'baltimore.vbn'));
    expect(await stateOf('baltimore.vbn', NOW)).toEqual({ status: 'refused', reason: 'flag_off' });
  });

  it('reports a MISSING flag as off — absence is not permission', async () => {
    await db.update(sources).set({ enabled: true }).where(eq(sources.key, 'baltimore.vbn'));
    await db.delete(featureFlags).where(eq(featureFlags.key, 'source.baltimore.vbn'));
    expect(await stateOf('baltimore.vbn', NOW)).toEqual({ status: 'refused', reason: 'flag_off' });
  });

  it.each(['md.case_search', 'md.land_records'])(
    'reports %s as scraping_not_allowed even when fully enabled',
    async (key) => {
      /* Spec §4.5 / §17.6. The legal constraint outranks the operational one, and it must be
         reported as the LEGAL reason — an operator who saw "disabled" might reasonably flip the
         row, which is exactly the mistake this ordering prevents. */
      await enable(key);
      expect(await stateOf(key, NOW)).toEqual({
        status: 'refused',
        reason: 'scraping_not_allowed',
      });
    },
  );

  it('never marks a ToS-restricted source due, under any clock', async () => {
    await enable('md.case_search');
    await db
      .update(sources)
      .set({ refreshCron: '* * * * *' })
      .where(eq(sources.key, 'md.case_search'));
    const due = dueNow(await classifySources(db, new Date('2030-01-01T00:00:00Z')));
    expect(due.map((s) => s.key)).not.toContain('md.case_search');
  });
});

describe('due computation', () => {
  it('treats a never-fetched source as due immediately', async () => {
    /* Any other answer delays the first Baltimore load by up to a full cron period for no
       reason. */
    await enable('baltimore.vbn');
    const state = await stateOf('baltimore.vbn', NOW);
    expect(state.status).toBe('due');
  });

  it('dates a never-fetched source to its WINDOW, not to the moment of asking', async () => {
    /*
     * The scheduler derives a BullMQ job id from `dueSince` so a per-minute sweep enqueues one
     * job per cron window. Returning `now` here would make that value differ on every sweep,
     * silently defeating the deduplication — 1,440 jobs a day for a daily source. So the value
     * must be a scheduled instant, and must not move between two sweeps in the same window.
     *
     * baltimore.vbn is seeded '0 6 * * *'; NOW is 12:00, so the window is today's 06:00.
     */
    await enable('baltimore.vbn');
    const first = await stateOf('baltimore.vbn', NOW);
    const later = await stateOf('baltimore.vbn', new Date('2026-08-12T12:59:00Z'));

    expect(first).toEqual({ status: 'due', dueSince: new Date('2026-08-12T06:00:00Z') });
    expect(later, 'the window must not move as the clock advances within it').toEqual(first);
  });

  it('is not due again until the next cron fire after the last success', async () => {
    /* baltimore.vbn is seeded '0 6 * * *' — daily at 06:00 UTC. */
    await enable('baltimore.vbn');
    await db
      .update(sources)
      .set({ lastSuccessAt: new Date('2026-08-12T06:00:00Z') })
      .where(eq(sources.key, 'baltimore.vbn'));

    const state = await stateOf('baltimore.vbn', NOW);
    expect(state.status).toBe('not_due');
    if (state.status !== 'not_due') return;
    expect(state.nextDueAt.toISOString()).toBe('2026-08-13T06:00:00.000Z');
  });

  it('becomes due once the window has passed', async () => {
    await enable('baltimore.vbn');
    await db
      .update(sources)
      .set({ lastSuccessAt: new Date('2026-08-11T06:00:00Z') })
      .where(eq(sources.key, 'baltimore.vbn'));

    const state = await stateOf('baltimore.vbn', NOW);
    expect(state.status).toBe('due');
    if (state.status !== 'due') return;
    expect(state.dueSince.toISOString()).toBe('2026-08-12T06:00:00.000Z');
  });

  it('is due — not skipped — after a worker outage spanning several windows', async () => {
    /* The reason due is derived from last_success_at rather than stored as a next-run: a
       missed window must not silently become a skipped refresh. */
    await enable('baltimore.vbn');
    await db
      .update(sources)
      .set({ lastSuccessAt: new Date('2026-08-01T06:00:00Z') })
      .where(eq(sources.key, 'baltimore.vbn'));
    expect((await stateOf('baltimore.vbn', NOW)).status).toBe('due');
  });

  it('reports an unscheduled source rather than calling it due', async () => {
    /* Internal producers have refresh_cron null — they are written to, not fetched. */
    expect(await stateOf('magnolia.derived', NOW)).toEqual({
      status: 'refused',
      reason: 'scraping_not_allowed',
    });

    /* md.sdat_entities is manual_upload with a null cron; enable it to get past refusal and
       confirm the null schedule is reported as such. */
    await db
      .update(sources)
      .set({ enabled: true, scrapingAllowed: true })
      .where(eq(sources.key, 'md.sdat_entities'));
    await db
      .update(featureFlags)
      .set({ enabled: true })
      .where(eq(featureFlags.key, 'source.md.sdat_entities'));
    expect(await stateOf('md.sdat_entities', NOW)).toEqual({ status: 'unscheduled' });
  });
});

describe('a broken cron is surfaced, not swallowed', () => {
  it('reports invalid_schedule rather than quietly never running', async () => {
    /* A source that silently never runs again, with no explanation, is the exact failure this
       codebase keeps finding in Baltimore's published datasets. Reproducing it in our own
       configuration would be worse, because we control this one. */
    await enable('baltimore.vbn');
    await db
      .update(sources)
      .set({ refreshCron: 'not a cron', lastSuccessAt: new Date('2026-08-11T06:00:00Z') })
      .where(eq(sources.key, 'baltimore.vbn'));

    const state = await stateOf('baltimore.vbn', NOW);
    expect(state.status).toBe('invalid_schedule');
  });

  it('does not enqueue a source with a broken cron', async () => {
    await enable('baltimore.vbn');
    await db
      .update(sources)
      .set({ refreshCron: 'not a cron', lastSuccessAt: new Date('2026-08-11T06:00:00Z') })
      .where(eq(sources.key, 'baltimore.vbn'));
    expect(dueNow(await classifySources(db, NOW)).map((s) => s.key)).not.toContain('baltimore.vbn');
  });
});

describe('sweep-level behaviour', () => {
  it('classifies every seeded source, leaving none unaccounted for', async () => {
    const all = await classifySources(db, NOW);
    const rows = await db.select({ key: sources.key }).from(sources);
    expect(all).toHaveLength(rows.length);
    expect(new Set(all.map((s) => s.key))).toEqual(new Set(rows.map((r) => r.key)));
  });

  it('enqueues nothing at all in the seeded posture', async () => {
    /* Invariant 8 end to end: a freshly seeded production database schedules no fetches until
       someone deliberately turns a source on. */
    expect(dueNow(await classifySources(db, NOW))).toEqual([]);
  });

  it('renders a summary that distinguishes refused from not-due', async () => {
    await enable('baltimore.vbn');
    await db
      .update(sources)
      .set({ lastSuccessAt: new Date('2026-08-12T06:00:00Z') })
      .where(eq(sources.key, 'baltimore.vbn'));

    const text = formatSchedule(await classifySources(db, NOW));
    expect(text).toMatch(/baltimore\.vbn\s+not_due/);
    expect(text).toMatch(/md\.case_search\s+refused\s+REFUSED \(scraping_not_allowed\)/);
  });
});
