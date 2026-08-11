import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, probability, ts } from './column-types.js';
import { actorKind, engineKind, subjectKind } from './enums.js';
import { opportunities, opportunityRoutes } from './opportunities.js';
import { transactions } from './transactions.js';

/** schema.sql §12-§14 — outcomes, learning, event bus, audit, operators. */

export const outcomes = pgTable(
  'outcomes',
  {
    id: uuid('id').primaryKey(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id),
    routeId: uuid('route_id').references(() => opportunityRoutes.id),
    transactionId: uuid('transaction_id').references(() => transactions.id),
    engine: engineKind('engine').notNull(),
    succeeded: boolean('succeeded').notNull(),
    paidAmountCents: bigint('paid_amount_cents', { mode: 'number' }).notNull().default(0),
    totalCostCents: bigint('total_cost_cents', { mode: 'number' }).notNull().default(0),
    netCents: bigint('net_cents', { mode: 'number' }).notNull().default(0),
    paidAt: ts('paid_at'),
    daysToCash: integer('days_to_cash'),
    humanMinutes: integer('human_minutes'),
    failureStage: text('failure_stage'),
    failureReason: text('failure_reason'),

    /* Spec §13.1 MUST: snapshotted when the opportunity first enters `contacting`. Capturing
       predictions after the outcome is known is worthless, and is the easiest thing to get
       wrong. These columns are written once, at that moment, and never updated. */
    predictedPPay: probability('predicted_p_pay'),
    predictedPayoutCents: bigint('predicted_payout_cents', { mode: 'number' }),
    predictedDays: integer('predicted_days'),
    predictedCostCents: integer('predicted_cost_cents'),
    scoreConfigVersion: text('score_config_version'),

    lessons: text('lessons'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('outcomes_engine_created_at_idx').on(table.engine, table.createdAt.desc().nullsFirst()),
  ],
);

export const calibrationBuckets = pgTable('calibration_buckets', {
  id: uuid('id').primaryKey(),
  engine: engineKind('engine').notNull(),
  configVersion: text('config_version').notNull(),
  bucketLow: probability('bucket_low').notNull(),
  bucketHigh: probability('bucket_high').notNull(),
  n: integer('n').notNull(),
  predictedMean: probability('predicted_mean').notNull(),
  actualRate: probability('actual_rate').notNull(),
  computedAt: ts('computed_at').notNull().defaultNow(),
});

export const experiments = pgTable('experiments', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull().unique(),
  hypothesis: text('hypothesis').notNull(),
  unit: text('unit').notNull(), // opportunity|contact|property
  variants: jsonb('variants').notNull(), // [{key, weight}]
  minSample: integer('min_sample').notNull(),
  startedAt: ts('started_at'),
  stoppedAt: ts('stopped_at'),
  result: jsonb('result'),
});

export const experimentAssignments = pgTable(
  'experiment_assignments',
  {
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => experiments.id),
    unitId: uuid('unit_id').notNull(),
    variantKey: text('variant_key').notNull(),
    assignedAt: ts('assigned_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'experiment_assignments_pkey',
      columns: [table.experimentId, table.unitId],
    }),
  ],
);

/**
 * Transactional outbox.
 *
 * BUILD_PLAN M1.6: `emitEvent` writes here inside the caller's DB transaction, and a publisher
 * worker moves rows to BullMQ. That ordering is what makes "the state changed but the event
 * never fired" impossible — the event commits or the state change rolls back, together.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    topic: text('topic').notNull(),
    subjectType: subjectKind('subject_type'),
    subjectId: uuid('subject_id'),
    payload: jsonb('payload').notNull(),
    dedupeKey: text('dedupe_key'),
    createdAt: ts('created_at').notNull().defaultNow(),
    publishedAt: ts('published_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [
    /* Invariant 7: the idempotency key for events. A re-run emits the same dedupe_key and the
       insert is a no-op rather than a duplicate downstream job. */
    uniqueIndex('events_dedupe')
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    index('events_unpublished')
      .on(table.createdAt)
      .where(sql`${table.publishedAt} is null`),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    actorKind: actorKind('actor_kind').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    subjectType: subjectKind('subject_type'),
    subjectId: uuid('subject_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    policyVersion: text('policy_version'),
    requestId: text('request_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_subject_type_subject_id_created_at_idx').on(
      table.subjectType,
      table.subjectId,
      table.createdAt.desc().nullsFirst(),
    ),
    index('audit_log_created_at_idx').on(table.createdAt.desc().nullsFirst()),
  ],
);

export const operators = pgTable('operators', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role').notNull().default('operator'), // operator|admin|readonly
  /* Invariant 6: only an operator carrying this may authorize a binding transition, and the
     system actor may never do so. Defaults to false. */
  canAuthorizeBinding: boolean('can_authorize_binding').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  operatorId: uuid('operator_id')
    .notNull()
    .references(() => operators.id),
  tokenHash: bytea('token_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});
