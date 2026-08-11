import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { probability, ts } from './column-types.js';
import { epistemicKind, subjectKind } from './enums.js';
import { rawRecords, sources } from './markets.js';

/** schema.sql §3 — the fact ledger. Spec §4.1. */

/**
 * Predicate registry. Every predicate a fact can use must be declared here.
 *
 * Spec §4.1: "Writing a fact with an unregistered predicate MUST throw." The FK from
 * `facts.predicate` is what makes that a database guarantee rather than a convention; the
 * value-shape half is enforced by `value_schema` in packages/core.
 */
export const predicates = pgTable('predicates', {
  key: text('key').primaryKey(), // 'vacancy.vbn_open'
  subject: subjectKind('subject').notNull(),
  valueSchema: jsonb('value_schema').notNull(), // JSON Schema for facts.value
  defaultTtlDays: integer('default_ttl_days'), // NULL = durable, never expires
  volatility: text('volatility').notNull().default('durable'), // durable|slow|volatile
  description: text('description'),
});

/**
 * The fact ledger. Everything Magnolia believes about the world is a row here.
 *
 * DELIBERATE DIVERGENCE FROM schema.sql (BUILD_PLAN M1.1 asks that these be noted):
 *
 *   `source_id` is NOT NULL here; schema.sql line 350 leaves it nullable.
 *
 * CLAUDE.md invariant 2 and spec §4.1 rule 2 both state that every fact carries a source, that
 * there is no default source, and that "a fact with no provenance is a bug". A nullable column
 * makes that bug representable, and AT-1 (every fact resolves to source, timestamp, confidence,
 * and epistemic level) cannot hold if the column can be NULL.
 *
 * Nothing legitimately needs the NULL: the `source_tier` enum includes `derived`,
 * `ai_inference`, and `human`, so Magnolia-produced and operator-entered facts each have a
 * source row to point at. The nullable column reads as an oversight in schema.sql rather than
 * an intended affordance — but it is a real difference, so it is flagged rather than quietly
 * applied. Relaxing it later is a one-line migration; tightening it after facts exist is not.
 */
export const facts = pgTable(
  'facts',
  {
    id: uuid('id').primaryKey(),
    subjectType: subjectKind('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    predicate: text('predicate')
      .notNull()
      .references(() => predicates.key),
    value: jsonb('value').notNull(),
    epistemic: epistemicKind('epistemic').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    sourceRecordId: text('source_record_id'),
    rawRecordId: uuid('raw_record_id').references(() => rawRecords.id),
    derivedFrom: uuid('derived_from').array(), // fact ids, for derived/inference
    observedAt: ts('observed_at').notNull(), // when true in the world
    recordedAt: ts('recorded_at').notNull().defaultNow(), // when Magnolia learned it
    expiresAt: ts('expires_at'),
    confidence: probability('confidence').notNull(),
    costCents: integer('cost_cents').notNull().default(0),
    superseded: uuid('superseded_by').references((): AnyPgColumn => facts.id),
    isCurrent: boolean('is_current').notNull().default(true),
  },
  (table) => [
    check('facts_confidence_check', sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
    index('facts_subject')
      .on(table.subjectType, table.subjectId, table.predicate)
      .where(sql`${table.isCurrent}`),
    /* At most one CURRENT fact per subject+predicate+source. Spec §4.1 rule 5 already intends
       this — superseding flips `is_current` on the old row — but nothing enforced it, leaving
       the invariant to application discipline. With the index, `recordFact` is correct by
       construction: a bug, a concurrent write, or a caller bypassing supersede fails loudly
       instead of silently producing two "current" facts from one source.

       This does not suppress conflict detection: rule 6 conflicts are disagreements between
       DIFFERENT sources, which this index leaves untouched. */
    uniqueIndex('facts_one_current_per_source')
      .on(table.subjectType, table.subjectId, table.predicate, table.sourceId)
      .where(sql`${table.isCurrent}`),
    index('facts_predicate_observed').on(table.predicate, table.observedAt.desc().nullsFirst()),
    index('facts_expiring')
      .on(table.expiresAt)
      .where(sql`${table.isCurrent} and ${table.expiresAt} is not null`),
  ],
);

/** Surfaced when two current facts on the same subject+predicate disagree. Spec §4.1 rule 6. */
export const factConflicts = pgTable(
  'fact_conflicts',
  {
    id: uuid('id').primaryKey(),
    subjectType: subjectKind('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    predicate: text('predicate').notNull(),
    factIds: uuid('fact_ids').array().notNull(),
    detectedAt: ts('detected_at').notNull().defaultNow(),
    resolution: text('resolution'), // prefer_tier|prefer_recent|operator|unresolved
    resolvedFactId: uuid('resolved_fact_id').references(() => facts.id),
    resolvedBy: text('resolved_by'),
    resolvedAt: ts('resolved_at'),
  },
  (table) => [
    index('fact_conflicts_resolved_at_idx')
      .on(table.resolvedAt)
      .where(sql`${table.resolvedAt} is null`),
  ],
);
