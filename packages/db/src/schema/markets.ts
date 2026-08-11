import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, probability, ts } from './column-types.js';
import { sourceTier } from './enums.js';

/** schema.sql §1 — markets, sources, config, flags. */

export const markets = pgTable('markets', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull().unique(), // 'baltimore_city_md'
  displayName: text('display_name').notNull(),
  stateCode: char('state_code', { length: 2 }).notNull(),
  fipsCounty: text('fips_county'),
  timezone: text('timezone').notNull().default('America/New_York'),
  status: text('status').notNull().default('pilot'), // pilot|active|paused|retired
  activatedAt: ts('activated_at'),
  config: jsonb('config').notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const sources = pgTable('sources', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull().unique(), // 'baltimore.vbn'
  marketId: uuid('market_id').references(() => markets.id),
  displayName: text('display_name').notNull(),
  tier: sourceTier('tier').notNull(),
  baseUrl: text('base_url'),
  accessMethod: text('access_method').notNull(), // arcgis_rest|socrata|csv|api|manual_upload
  licenseNote: text('license_note'),
  tosUrl: text('tos_url'),
  /* Spec §4.5: defaults to false. A source is opt-in to automated access, never opt-out. */
  scrapingAllowed: boolean('scraping_allowed').notNull().default(false),
  refreshCron: text('refresh_cron'),
  baseConfidence: probability('base_confidence').notNull().default(0.9),
  costModel: jsonb('cost_model').notNull().default({}),
  enabled: boolean('enabled').notNull().default(true),
  lastSuccessAt: ts('last_success_at'),
  lastErrorAt: ts('last_error_at'),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Raw payload archive. NEVER parsed in place; normalized into facts. */
export const sourceFetches = pgTable(
  'source_fetches',
  {
    id: uuid('id').primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    cursorBefore: text('cursor_before'),
    cursorAfter: text('cursor_after'),
    recordCount: integer('record_count'),
    bytes: bigint('bytes', { mode: 'number' }),
    httpStatus: integer('http_status'),
    ok: boolean('ok'),
    error: text('error'),
    costCents: integer('cost_cents').notNull().default(0),
    storageUri: text('storage_uri'),
  },
  (table) => [
    index('source_fetches_source_id_started_at_idx').on(
      table.sourceId,
      table.startedAt.desc().nullsFirst(),
    ),
  ],
);

export const rawRecords = pgTable(
  'raw_records',
  {
    id: uuid('id').primaryKey(),
    fetchId: uuid('fetch_id')
      .notNull()
      .references(() => sourceFetches.id),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    sourceRecordId: text('source_record_id'),
    payload: jsonb('payload').notNull(),
    payloadHash: bytea('payload_hash').notNull(),
    observedAt: ts('observed_at').notNull(),
    normalizedAt: ts('normalized_at'),
    normalizeError: text('normalize_error'),
  },
  (table) => [
    /* Invariant 7 (idempotency): re-fetching identical source data creates no new raw record,
       so re-running ingestion cannot fan out into duplicate facts. AT-2 depends on this. */
    uniqueIndex('raw_records_dedupe').on(table.sourceId, table.payloadHash),
    index('raw_records_source_id_source_record_id_idx').on(table.sourceId, table.sourceRecordId),
    index('raw_records_normalized_at_idx')
      .on(table.normalizedAt)
      .where(sql`${table.normalizedAt} is null`),
  ],
);

export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(), // 'engine.recovery', 'outbound.global'
  /* Invariant 8: kill switches default off for anything that spends money or contacts a
     person. The column default encodes that for every flag. */
  enabled: boolean('enabled').notNull().default(false),
  marketId: uuid('market_id').references(() => markets.id),
  note: text('note'),
  updatedBy: text('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const spendCaps = pgTable(
  'spend_caps',
  {
    id: uuid('id').primaryKey(),
    scope: text('scope').notNull(), // 'global'|'market:<key>'|'category:<cat>'|'opportunity'
    period: text('period').notNull(), // 'day'|'week'|'month'|'lifetime'
    capCents: integer('cap_cents').notNull(),
    hardStop: boolean('hard_stop').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [unique('spend_caps_scope_period_key').on(table.scope, table.period)],
);

export const spendCounters = pgTable(
  'spend_counters',
  {
    scope: text('scope').notNull(),
    periodStart: date('period_start').notNull(),
    period: text('period').notNull(),
    spentCents: integer('spent_cents').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'spend_counters_pkey',
      columns: [table.scope, table.period, table.periodStart],
    }),
  ],
);
