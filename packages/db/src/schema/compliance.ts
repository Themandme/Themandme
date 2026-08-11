import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, probability, ts } from './column-types.js';
import {
  commChannel,
  commDirection,
  commStatus,
  complianceDecision,
  consentScope,
  subjectKind,
  suppressionReason,
} from './enums.js';
import { contacts, persons } from './graph.js';
import { opportunities } from './opportunities.js';

/** schema.sql §7-§8 — consent, suppression, compliance, communications. */

export const consents = pgTable(
  'consents',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id').references(() => persons.id),
    contactId: uuid('contact_id').references(() => contacts.id),
    contactHash: bytea('contact_hash').notNull(), // works even before person resolution
    scope: consentScope('scope').notNull(),
    granted: boolean('granted').notNull(),
    // web_form|ivr_keypress|verbal_recorded|written|inbound_initiated
    method: text('method').notNull(),
    evidenceUri: text('evidence_uri'), // recording or form submission artifact
    evidenceText: text('evidence_text'), // exact disclosure language shown/spoken
    capturedAt: ts('captured_at').notNull(),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    revokedMethod: text('revoked_method'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('consents_lookup').on(table.contactHash, table.scope, table.granted, table.revokedAt),
  ],
);

/**
 * Suppression list.
 *
 * AT-11 and spec §10.3: a `doNotContact` extraction or an inbound STOP writes here *before any
 * other processing*, and the next send attempt is denied. Keyed on hash so it works before
 * person resolution.
 */
export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').primaryKey(),
    contactHash: bytea('contact_hash').notNull(),
    contactValue: text('contact_value'), // retained for operator debugging only
    scope: text('scope').notNull().default('all'), // all|sms|voice|email|mail
    reason: suppressionReason('reason').notNull(),
    source: text('source'),
    addedAt: ts('added_at').notNull().defaultNow(),
    expiresAt: ts('expires_at'),
    note: text('note'),
  },
  (table) => [
    uniqueIndex('suppressions_key').on(table.contactHash, table.scope, table.reason),
    index('suppressions_contact_hash_idx').on(table.contactHash),
  ],
);

export const complianceChecks = pgTable(
  'compliance_checks',
  {
    id: uuid('id').primaryKey(),
    policyVersion: text('policy_version').notNull(),
    actionType: text('action_type').notNull(), // 'comm.send'|'txn.advance'|'spend.commit'
    subjectType: subjectKind('subject_type'),
    subjectId: uuid('subject_id'),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id),
    decision: complianceDecision('decision').notNull(),
    rulesEvaluated: jsonb('rules_evaluated').notNull(), // [{rule, result, detail}]
    blockingRules: text('blocking_rules').array(),
    reviewedBy: text('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    reviewOutcome: complianceDecision('review_outcome'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('compliance_checks_decision_created_at_idx').on(
      table.decision,
      table.createdAt.desc().nullsFirst(),
    ),
    index('compliance_checks_opportunity_id_idx').on(table.opportunityId),
  ],
);

export const commTemplates = pgTable(
  'comm_templates',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    channel: commChannel('channel').notNull(),
    version: integer('version').notNull().default(1),
    body: text('body').notNull(),
    requiredDisclosures: text('required_disclosures')
      .array()
      .notNull()
      .default(sql`'{}'`),
    approvedBy: text('approved_by'),
    approvedAt: ts('approved_at'),
    isActive: boolean('is_active').notNull().default(false),
    experimentId: uuid('experiment_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('comm_templates_key_version_key').on(table.key, table.version)],
);

/**
 * Communications.
 *
 * Invariant 3: `compliance_check_id` is NOT NULL for every *outbound* row. It is nullable at
 * the column level because inbound rows legitimately have no grant; the outbound half is
 * enforced by a DB trigger. schema.sql line 594 states the intent but ships no trigger body —
 * BUILD_PLAN M4.4 assigns building it, and this table is not written to before M7, so the
 * ordering holds. See `packages/db/src/schema/README-triggers.md`.
 */
export const communications = pgTable(
  'communications',
  {
    id: uuid('id').primaryKey(),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id),
    personId: uuid('person_id').references(() => persons.id),
    contactId: uuid('contact_id').references(() => contacts.id),
    direction: commDirection('direction').notNull(),
    channel: commChannel('channel').notNull(),
    provider: text('provider'), // 'twilio'|'bland'|'lob'|'postmark'
    providerMessageId: text('provider_message_id'),
    templateId: uuid('template_id').references(() => commTemplates.id),
    variantKey: text('variant_key'),
    complianceCheckId: uuid('compliance_check_id').references(() => complianceChecks.id),
    status: commStatus('status').notNull().default('queued'),
    scheduledFor: ts('scheduled_for'),
    sentAt: ts('sent_at'),
    completedAt: ts('completed_at'),
    durationSeconds: integer('duration_seconds'),
    body: text('body'),
    recordingUri: text('recording_uri'),
    /* Spec §2.2: Maryland is all-party consent. A recorded call links the consent artifact. */
    recordingConsentId: uuid('recording_consent_id').references(() => consents.id),
    transcriptUri: text('transcript_uri'),
    costCents: integer('cost_cents').notNull().default(0),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('communications_opportunity_id_created_at_idx').on(
      table.opportunityId,
      table.createdAt.desc().nullsFirst(),
    ),
    index('communications_contact_id_created_at_idx').on(
      table.contactId,
      table.createdAt.desc().nullsFirst(),
    ),
    index('communications_status_scheduled_for_idx')
      .on(table.status, table.scheduledFor)
      .where(sql`${table.status} in ('queued','sending')`),
  ],
);

export const conversationExtractions = pgTable(
  'conversation_extractions',
  {
    id: uuid('id').primaryKey(),
    communicationId: uuid('communication_id')
      .notNull()
      .references(() => communications.id),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id),
    extractorVersion: text('extractor_version').notNull(),
    motivation: text('motivation'), // none|low|medium|high
    timelineDays: integer('timeline_days'),
    conditionGrade: text('condition_grade'), // turnkey|light|moderate|heavy|teardown
    occupancy: text('occupancy'), // vacant|owner|tenant|unknown
    sellerPriceCents: bigint('seller_price_cents', { mode: 'number' }),
    reason: text('reason'),
    otherDecisionMaker: boolean('other_decision_maker'),
    openToOffer: boolean('open_to_offer'),
    requestedFollowupAt: ts('requested_followup_at'),
    doNotContact: boolean('do_not_contact').notNull().default(false),
    raw: jsonb('raw').notNull(),
    confidence: probability('confidence'),
    needsHumanReview: boolean('needs_human_review').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('conversation_extractions_opportunity_id_created_at_idx').on(
      table.opportunityId,
      table.createdAt.desc().nullsFirst(),
    ),
  ],
);
