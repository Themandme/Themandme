import { sql } from 'drizzle-orm';
import { bigint, check, date, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { ts } from './column-types.js';
import { actorKind, engineKind, ledgerCategory, ledgerDirection, txnState } from './enums.js';
import { persons } from './graph.js';
import { markets } from './markets.js';
import { buyers } from './buyers.js';
import { complianceChecks } from './compliance.js';
import { opportunities, opportunityRoutes } from './opportunities.js';

/** schema.sql §10-§11 — transactions and the ledger. Spec §11. */

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id),
    routeId: uuid('route_id')
      .notNull()
      .references(() => opportunityRoutes.id),
    engine: engineKind('engine').notNull(),
    state: txnState('state').notNull().default('qualified'),
    sellerPersonId: uuid('seller_person_id').references(() => persons.id),
    buyerId: uuid('buyer_id').references(() => buyers.id),
    contractPriceCents: bigint('contract_price_cents', { mode: 'number' }),
    assignmentFeeCents: bigint('assignment_fee_cents', { mode: 'number' }),
    expectedCloseDate: date('expected_close_date'),
    actualCloseDate: date('actual_close_date'),
    titleCompany: text('title_company'),
    /* Spec §2.4 / Md. RP § 3-104(f)(1): a deed must be attorney-prepared. `closing` cannot be
       entered without this populated — a blocking gate, not a reminder. */
    closingAttorney: text('closing_attorney'),
    /* Spec §11.2: stall detection runs off the clock and this column, never off a provider
       callback, so a dropped webhook cannot silently freeze a deal. AT-12. */
    stateEnteredAt: ts('state_entered_at').notNull().defaultNow(),
    deadlineAt: ts('deadline_at'),
    ownerOperator: text('owner_operator'),
    terminatedReason: text('terminated_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (table) => [index('transactions_state_deadline_at_idx').on(table.state, table.deadlineAt)],
);

export const transactionTransitions = pgTable('transaction_transitions', {
  id: uuid('id').primaryKey(),
  transactionId: uuid('transaction_id')
    .notNull()
    .references(() => transactions.id),
  fromState: txnState('from_state'),
  toState: txnState('to_state').notNull(),
  actorKind: actorKind('actor_kind').notNull(),
  actorId: text('actor_id'),
  /* Invariant 6: required for binding transitions, and the system actor may never supply it.
     Enforced by the compliance rule `txn.binding_authorization` (spec §8.2). AT-4. */
  authorizedBy: text('authorized_by'),
  complianceCheckId: uuid('compliance_check_id').references(() => complianceChecks.id),
  note: text('note'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Gate artifacts. A transition is blocked until all required artifacts exist. Spec §11.3. */
export const transactionArtifacts = pgTable(
  'transaction_artifacts',
  {
    id: uuid('id').primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),
    artifactKey: text('artifact_key').notNull(),
    storageUri: text('storage_uri'),
    signedAt: ts('signed_at'),
    signedBy: text('signed_by'),
    verifiedBy: text('verified_by'),
    verifiedAt: ts('verified_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('transaction_artifacts_transaction_id_artifact_key_key').on(
      table.transactionId,
      table.artifactKey,
    ),
  ],
);

/**
 * Cost and revenue ledger.
 *
 * Spec §9.2: every provider lookup posts a row whether or not it returned anything — a failed
 * $0.15 lookup is still $0.15. Spec §11.3: entering `paid` writes the outcome row and the
 * revenue row in the same database transaction.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey(),
    direction: ledgerDirection('direction').notNull(),
    category: ledgerCategory('category').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id),
    routeId: uuid('route_id').references(() => opportunityRoutes.id),
    transactionId: uuid('transaction_id').references(() => transactions.id),
    marketId: uuid('market_id').references(() => markets.id),
    vendor: text('vendor'),
    externalRef: text('external_ref'),
    memo: text('memo'),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    check('ledger_entries_amount_cents_check', sql`${table.amountCents} >= 0`),
    index('ledger_entries_opportunity_id_idx').on(table.opportunityId),
    index('ledger_entries_occurred_at_idx').on(table.occurredAt.desc().nullsFirst()),
    index('ledger_entries_market_id_direction_occurred_at_idx').on(
      table.marketId,
      table.direction,
      table.occurredAt.desc().nullsFirst(),
    ),
  ],
);
