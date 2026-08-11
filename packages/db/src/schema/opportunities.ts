import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { probability, ts } from './column-types.js';
import { actionKind, engineKind, lifecycleState, opportunityStatus, routeState } from './enums.js';
import { properties } from './graph.js';
import { markets, sources } from './markets.js';
import { persons } from './graph.js';

/** schema.sql §4-§6 — signals, opportunities, routes, next actions. */

export const signals = pgTable(
  'signals',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    signalType: text('signal_type').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    strength: probability('strength').notNull().default(1.0),
    /* Spec §4.4: evidence is required, and it is what the deal-replay view renders. A signal
       that cannot point at the facts behind it is not auditable. */
    evidenceFactIds: uuid('evidence_fact_ids').array().notNull(),
    openedAt: ts('opened_at').notNull(),
    closedAt: ts('closed_at'),
    lastConfirmedAt: ts('last_confirmed_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    /* Signals are opened and closed, never mutated — so at most one active row per
       (property, type). Re-running the signal engine cannot fan out duplicates (AT-2). */
    uniqueIndex('signals_active_key')
      .on(table.propertyId, table.signalType)
      .where(sql`${table.isActive}`),
    index('signals_signal_type_idx')
      .on(table.signalType)
      .where(sql`${table.isActive}`),
  ],
);

export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    status: opportunityStatus('status').notNull().default('new'),
    lifecycle: lifecycleState('lifecycle').notNull().default('created'),
    cohortKey: text('cohort_key'),
    discoveredVia: uuid('discovered_via').references(() => sources.id),
    primaryPersonId: uuid('primary_person_id').references(() => persons.id),
    /* Circular by design: routes belong to an opportunity, and the opportunity points back at
       its winning route. Drizzle resolves the callback lazily, so the cycle is fine. */
    bestRouteId: uuid('best_route_id').references((): AnyPgColumn => opportunityRoutes.id),
    rankScore: numeric('rank_score', { precision: 8, scale: 4, mode: 'number' })
      .notNull()
      .default(0),
    spentCents: integer('spent_cents').notNull().default(0),
    revenueCents: integer('revenue_cents').notNull().default(0),
    humanMinutes: integer('human_minutes').notNull().default(0),
    firstContactAt: ts('first_contact_at'),
    lastActivityAt: ts('last_activity_at'),
    staleAfter: ts('stale_after'),
    closedAt: ts('closed_at'),
    closeReason: text('close_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('opportunities_market_id_status_idx').on(table.marketId, table.status),
    index('opportunities_rank_score_idx')
      .on(table.rankScore.desc().nullsFirst())
      .where(sql`${table.status} not in ('dead','paid')`),
    uniqueIndex('opportunities_open_per_property')
      .on(table.propertyId)
      .where(sql`${table.status} not in ('dead','paid')`),
  ],
);

export const opportunityRoutes = pgTable(
  'opportunity_routes',
  {
    id: uuid('id').primaryKey(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    engine: engineKind('engine').notNull(),
    state: routeState('state').notNull().default('candidate'),

    // Economics (spec §6). All model outputs, versioned by score_config_version.
    payoutCentsP50: bigint('payout_cents_p50', { mode: 'number' }),
    payoutCentsP10: bigint('payout_cents_p10', { mode: 'number' }),
    payoutCentsP90: bigint('payout_cents_p90', { mode: 'number' }),
    pursuitCostCents: integer('pursuit_cost_cents'),
    capitalRequiredCents: bigint('capital_required_cents', { mode: 'number' }).notNull().default(0),
    pPay: probability('p_pay'),
    daysToCashP50: integer('days_to_cash_p50'),
    humanMinutesEst: integer('human_minutes_est'),
    confidence: probability('confidence'),
    evCents: bigint('ev_cents', { mode: 'number' }), // p_pay*payout_p50 - pursuit_cost
    rankScore: numeric('rank_score', { precision: 8, scale: 4, mode: 'number' }),
    scoreConfigVersion: text('score_config_version'),
    scoredAt: ts('scored_at'),
    rejectedReason: text('rejected_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('opportunity_routes_opportunity_id_engine_key').on(table.opportunityId, table.engine),
    index('opportunity_routes_engine_state_rank_score_idx').on(
      table.engine,
      table.state,
      table.rankScore.desc().nullsFirst(),
    ),
  ],
);

export const scoreRuns = pgTable(
  'score_runs',
  {
    id: uuid('id').primaryKey(),
    routeId: uuid('route_id')
      .notNull()
      .references(() => opportunityRoutes.id, { onDelete: 'cascade' }),
    configVersion: text('config_version').notNull(),
    triggerEvent: text('trigger_event'),
    inputs: jsonb('inputs').notNull(), // signal set + facts used
    outputs: jsonb('outputs').notNull(), // every component score
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('score_runs_route_id_created_at_idx').on(
      table.routeId,
      table.createdAt.desc().nullsFirst(),
    ),
  ],
);

export const nextActions = pgTable(
  'next_actions',
  {
    id: uuid('id').primaryKey(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    routeId: uuid('route_id').references(() => opportunityRoutes.id),
    kind: actionKind('kind').notNull(),
    /* Spec §7.2: one sentence, rendered verbatim in the dashboard, referencing specific
       evidence ("VBN open 412 days") not a category ("high distress score"). */
    reason: text('reason').notNull(),
    dueAt: ts('due_at').notNull(),
    requiresHuman: boolean('requires_human').notNull().default(false),
    estCostCents: integer('est_cost_cents').notNull().default(0),
    estValueCents: bigint('est_value_cents', { mode: 'number' }).notNull().default(0),
    payload: jsonb('payload').notNull().default({}),
    isOpen: boolean('is_open').notNull().default(true),
    completedAt: ts('completed_at'),
    outcome: text('outcome'),
    superseded: uuid('superseded_by').references((): AnyPgColumn => nextActions.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    /* Invariant 4, and the whole of AT-7. This partial unique index is the enforcement — the
       application cannot win a race against it, which is the point. */
    uniqueIndex('next_actions_one_open')
      .on(table.opportunityId)
      .where(sql`${table.isOpen}`),
    index('next_actions_due_at_idx')
      .on(table.dueAt)
      .where(sql`${table.isOpen}`),
    index('next_actions_requires_human_due_at_idx')
      .on(table.requiresHuman, table.dueAt)
      .where(sql`${table.isOpen}`),
  ],
);
