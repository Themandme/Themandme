import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { probability, ts } from './column-types.js';
import { persons, properties } from './graph.js';
import { markets, sources } from './markets.js';
import { opportunityRoutes } from './opportunities.js';

/** schema.sql §9 — buyer intelligence. Spec §6.4, BUILD_PLAN M10. */

export const buyers = pgTable('buyers', {
  id: uuid('id').primaryKey(),
  marketId: uuid('market_id')
    .notNull()
    .references(() => markets.id),
  personId: uuid('person_id').references(() => persons.id),
  displayName: text('display_name').notNull(),
  companyName: text('company_name'),
  // flipper|landlord|builder|land|ibuyer|owner_occupant
  buyerType: text('buyer_type').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  contactability: probability('contactability').notNull().default(0.5),
  reliabilityScore: probability('reliability_score'), // observed close rate on our deals
  dealsOffered: integer('deals_offered').notNull().default(0),
  dealsAccepted: integer('deals_accepted').notNull().default(0),
  dealsClosed: integer('deals_closed').notNull().default(0),
  dealsFellThrough: integer('deals_fell_through').notNull().default(0),
  lastActivityAt: ts('last_activity_at'),
  notes: text('notes'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** What they SAY they buy. Lower confidence by construction — note the 0.4 default. */
export const buyerStatedCriteria = pgTable('buyer_stated_criteria', {
  id: uuid('id').primaryKey(),
  buyerId: uuid('buyer_id')
    .notNull()
    .references(() => buyers.id),
  criteria: jsonb('criteria').notNull(),
  statedAt: ts('stated_at').notNull(),
  statedVia: text('stated_via'),
  confidence: probability('confidence').notNull().default(0.4),
});

/** What they ACTUALLY bought. Higher confidence; spec §6.4 weights this far above stated. */
export const buyerPurchases = pgTable(
  'buyer_purchases',
  {
    id: uuid('id').primaryKey(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id),
    propertyId: uuid('property_id').references(() => properties.id),
    purchaseDate: date('purchase_date').notNull(),
    priceCents: bigint('price_cents', { mode: 'number' }),
    propertyType: text('property_type'),
    beds: numeric('beds', { precision: 4, scale: 1, mode: 'number' }),
    baths: numeric('baths', { precision: 4, scale: 1, mode: 'number' }),
    buildingSqft: integer('building_sqft'),
    lotSqft: integer('lot_sqft'),
    zip: text('zip'),
    neighborhood: text('neighborhood'),
    isLand: boolean('is_land').notNull().default(false),
    resoldDate: date('resold_date'),
    resoldPriceCents: bigint('resold_price_cents', { mode: 'number' }),
    sourceId: uuid('source_id').references(() => sources.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('buyer_purchases_buyer_id_purchase_date_idx').on(
      table.buyerId,
      table.purchaseDate.desc().nullsFirst(),
    ),
    index('buyer_purchases_zip_purchase_date_idx').on(
      table.zip,
      table.purchaseDate.desc().nullsFirst(),
    ),
  ],
);

/** Derived buy-box, recomputed on buyer_purchases change. */
export const buyerObservedProfiles = pgTable('buyer_observed_profiles', {
  buyerId: uuid('buyer_id')
    .primaryKey()
    .references(() => buyers.id),
  priceP10Cents: bigint('price_p10_cents', { mode: 'number' }),
  priceP50Cents: bigint('price_p50_cents', { mode: 'number' }),
  priceP90Cents: bigint('price_p90_cents', { mode: 'number' }),
  zips: text('zips').array(),
  neighborhoods: text('neighborhoods').array(),
  propertyTypes: text('property_types').array(),
  bedsMin: numeric('beds_min', { precision: 4, scale: 1, mode: 'number' }),
  bedsMax: numeric('beds_max', { precision: 4, scale: 1, mode: 'number' }),
  sqftMin: integer('sqft_min'),
  sqftMax: integer('sqft_max'),
  buysLand: boolean('buys_land').notNull().default(false),
  purchaseCount24mo: integer('purchase_count_24mo').notNull().default(0),
  medianDaysToClose: integer('median_days_to_close'),
  recomputedAt: ts('recomputed_at').notNull().defaultNow(),
});

export const buyerMatches = pgTable(
  'buyer_matches',
  {
    id: uuid('id').primaryKey(),
    routeId: uuid('route_id')
      .notNull()
      .references(() => opportunityRoutes.id, { onDelete: 'cascade' }),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id),
    score: probability('score').notNull(),
    /* BUILD_PLAN M10 DoD: matches must return the specific comparable purchases that justify
       each score. That evidence lives here. */
    evidence: jsonb('evidence').notNull(),
    presentedAt: ts('presented_at'),
    response: text('response'), // interested|pass|no_response
    responseReason: text('response_reason'),
    respondedAt: ts('responded_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('buyer_matches_route_id_buyer_id_key').on(table.routeId, table.buyerId),
    index('buyer_matches_route_id_score_idx').on(table.routeId, table.score.desc().nullsFirst()),
  ],
);
