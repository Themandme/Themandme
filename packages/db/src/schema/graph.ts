import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, geometryMultiPolygon, geometryPoint, probability, ts } from './column-types.js';
import { contactKind } from './enums.js';
import { markets, sources } from './markets.js';

/** schema.sql §2 — property / parcel / person graph. */

export const properties = pgTable(
  'properties',
  {
    id: uuid('id').primaryKey(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id),

    // Canonical identity
    apn: text('apn'), // SDAT account id / block-lot
    blocklot: text('blocklot'), // Baltimore City BLOCKLOT
    addressLine1: text('address_line1').notNull(),
    addressLine2: text('address_line2'),
    city: text('city').notNull(),
    stateCode: char('state_code', { length: 2 }).notNull(),
    postalCode: text('postal_code'),
    addressNorm: text('address_norm').notNull(), // USPS-normalized, uppercased, no punctuation
    addressHash: bytea('address_hash').notNull(), // sha256(address_norm || postal_code)
    centroid: geometryPoint('centroid'),

    /* Denormalized read model. Invariant 1: recomputed from current facts by the projector in
       packages/core/src/read-model — never written directly by an ingestor or a service. */
    propertyType: text('property_type'),
    yearBuilt: integer('year_built'),
    buildingSqft: integer('building_sqft'),
    lotSqft: integer('lot_sqft'),
    beds: numeric('beds', { precision: 4, scale: 1, mode: 'number' }),
    baths: numeric('baths', { precision: 4, scale: 1, mode: 'number' }),
    zoningCode: text('zoning_code'),
    lastSaleDate: date('last_sale_date'),
    lastSalePriceCents: bigint('last_sale_price_cents', { mode: 'number' }),
    assessedValueCents: bigint('assessed_value_cents', { mode: 'number' }),
    isVacantLand: boolean('is_vacant_land').notNull().default(false),
    readModelAt: ts('read_model_at'),

    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /* Spec §4.3 entity resolution, tiers 1 and 2. Both are unique, so re-running ingestion
       cannot create a second property for the same APN or address — half of AT-2. */
    uniqueIndex('properties_apn_key')
      .on(table.marketId, table.apn)
      .where(sql`${table.apn} is not null`),
    uniqueIndex('properties_address_key').on(table.marketId, table.addressHash),
    index('properties_centroid_gix').using('gist', table.centroid),
    /* Spec §4.3 tier 3: fuzzy address match >= 0.92 needs a trigram index to be affordable. */
    index('properties_addr_trgm').using('gin', sql`${table.addressNorm} gin_trgm_ops`),
  ],
);

export const parcels = pgTable(
  'parcels',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id').references(() => properties.id),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id),
    apn: text('apn').notNull(),
    geom: geometryMultiPolygon('geom'),
    areaSqft: integer('area_sqft'),
    frontageFt: numeric('frontage_ft', { precision: 8, scale: 2, mode: 'number' }),
    depthFt: numeric('depth_ft', { precision: 8, scale: 2, mode: 'number' }),
    shapeRatio: numeric('shape_ratio', { precision: 6, scale: 3, mode: 'number' }),
    roadAccess: boolean('road_access'),
    floodZone: text('flood_zone'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('parcels_apn_key').on(table.marketId, table.apn),
    index('parcels_geom_gix').using('gist', table.geom),
  ],
);

/** Precomputed adjacency for cluster/assemblage analysis (cheap filter). */
export const parcelAdjacency = pgTable(
  'parcel_adjacency',
  {
    parcelId: uuid('parcel_id')
      .notNull()
      .references(() => parcels.id),
    neighborId: uuid('neighbor_id')
      .notNull()
      .references(() => parcels.id),
    sharedEdgeFt: numeric('shared_edge_ft', { precision: 8, scale: 2, mode: 'number' }),
  },
  (table) => [
    primaryKey({ name: 'parcel_adjacency_pkey', columns: [table.parcelId, table.neighborId] }),
  ],
);

export const persons = pgTable(
  'persons',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull().default('individual'), // individual|entity
    displayName: text('display_name').notNull(),
    nameNorm: text('name_norm').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    entityName: text('entity_name'),
    entityState: char('entity_state', { length: 2 }),
    entityRegistryId: text('entity_registry_id'), // SDAT entity id
    isDeceased: boolean('is_deceased').notNull().default(false),
    identityConfidence: probability('identity_confidence').notNull().default(0.5),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('persons_name_trgm').using('gin', sql`${table.nameNorm} gin_trgm_ops`),
    index('persons_entity_registry')
      .on(table.entityRegistryId)
      .where(sql`${table.entityRegistryId} is not null`),
  ],
);

/**
 * Resolves LLC -> officers, heirs, etc.
 *
 * Spec §4.3: person merges are reversible — a merge writes a `same_as` link rather than
 * destroying rows, so a wrong merge is undoable.
 */
export const personLinks = pgTable(
  'person_links',
  {
    fromPersonId: uuid('from_person_id')
      .notNull()
      .references(() => persons.id),
    toPersonId: uuid('to_person_id')
      .notNull()
      .references(() => persons.id),
    relation: text('relation').notNull(), // officer_of|agent_for|spouse|heir|same_as
    confidence: probability('confidence').notNull(),
    sourceId: uuid('source_id').references(() => sources.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'person_links_pkey',
      columns: [table.fromPersonId, table.toPersonId, table.relation],
    }),
  ],
);

export const propertyPersonRoles = pgTable(
  'property_person_roles',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    // owner_of_record|co_owner|mortgagee|tenant|personal_representative|receiver|lienholder
    role: text('role').notNull(),
    ownershipPct: numeric('ownership_pct', { precision: 6, scale: 3, mode: 'number' }),
    startDate: date('start_date'),
    endDate: date('end_date'),
    isCurrent: boolean('is_current').notNull().default(true),
    sourceId: uuid('source_id').references(() => sources.id),
    confidence: probability('confidence').notNull().default(0.8),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('property_person_roles_property_id_idx')
      .on(table.propertyId)
      .where(sql`${table.isCurrent}`),
    index('property_person_roles_person_id_idx')
      .on(table.personId)
      .where(sql`${table.isCurrent}`),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    kind: contactKind('kind').notNull(),
    valueRaw: text('value_raw').notNull(),
    valueNorm: text('value_norm').notNull(), // E.164 for phones, lowercased for email
    valueHash: bytea('value_hash').notNull(),
    confidence: probability('confidence').notNull(),
    lineType: text('line_type'), // mobile|landline|voip (from carrier lookup)
    carrier: text('carrier'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastVerifiedAt: ts('last_verified_at'),
    lastGoodAt: ts('last_good_at'), // last time it produced a real human
    badCount: integer('bad_count').notNull().default(0),
    sourceId: uuid('source_id').references(() => sources.id),
    costCents: integer('cost_cents').notNull().default(0),
    isSuppressed: boolean('is_suppressed').notNull().default(false), // denormalized
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('contacts_person_value').on(table.personId, table.valueHash),
    /* Suppression matches on hash alone (spec §8.2 `suppression.list`), so this index is on
       the revocation path, not just a lookup convenience. */
    index('contacts_value_hash').on(table.valueHash),
  ],
);
