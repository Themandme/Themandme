-- =====================================================================
-- MAGNOLIA V1 — CANONICAL DATABASE SCHEMA
-- Target: PostgreSQL 16 + PostGIS 3.4
-- Migration tool: Drizzle Kit (this file is the source of truth for review;
--                 generate/commit Drizzle migrations that match it exactly)
-- =====================================================================
-- CONVENTIONS
--   * All ids are UUID v7 (time-ordered). Use pg_uuidv7 ext or app-side generation.
--   * All timestamps are timestamptz, stored UTC.
--   * All money is INTEGER cents (never float, never numeric-for-money).
--   * All probabilities are numeric(5,4) in [0,1].
--   * Soft delete is NOT used. Use status/lifecycle columns.
--   * Every table that records an assertion about the world carries provenance.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- CREATE EXTENSION IF NOT EXISTS pg_uuidv7;  -- or generate uuidv7 in app layer

-- =====================================================================
-- 0. ENUMS
-- =====================================================================

CREATE TYPE epistemic_kind AS ENUM ('fact', 'prediction', 'inference');

CREATE TYPE subject_kind AS ENUM (
  'property', 'parcel', 'person', 'organization', 'contact',
  'buyer', 'opportunity', 'transaction'
);

CREATE TYPE source_tier AS ENUM (
  'official_record',    -- county/city/state system of record
  'commercial_data',    -- paid vendor
  'secondary',          -- aggregator, listing site, news
  'derived',            -- computed by Magnolia from other facts
  'ai_inference',       -- produced by an LLM
  'human'               -- entered or confirmed by an operator
);

CREATE TYPE engine_kind AS ENUM ('wholesale', 'land', 'recovery');

CREATE TYPE opportunity_status AS ENUM (
  'new', 'qualified', 'contacting', 'engaged', 'negotiating',
  'contracted', 'monetizing', 'closing', 'paid', 'dead', 'nurture'
);

CREATE TYPE route_state AS ENUM ('candidate', 'active', 'preserved', 'rejected', 'won', 'lost');

CREATE TYPE lifecycle_state AS ENUM ('created', 'active', 'aging', 'stale', 'recycled', 'closed');

CREATE TYPE comm_channel AS ENUM ('voice_human', 'voice_ai', 'sms', 'email', 'mail', 'in_person');

CREATE TYPE comm_direction AS ENUM ('outbound', 'inbound');

CREATE TYPE comm_status AS ENUM (
  'blocked', 'queued', 'sending', 'sent', 'delivered',
  'failed', 'bounced', 'answered', 'no_answer', 'voicemail', 'replied'
);

CREATE TYPE contact_kind AS ENUM ('phone_mobile', 'phone_landline', 'phone_unknown', 'email', 'mailing_address');

CREATE TYPE consent_scope AS ENUM (
  'sms_marketing', 'sms_transactional', 'ai_voice', 'call_recording',
  'email_marketing', 'prerecorded_voice'
);

CREATE TYPE suppression_reason AS ENUM (
  'federal_dnc', 'state_dnc', 'internal_dnc', 'consumer_revocation',
  'litigator_list', 'wrong_number', 'deceased', 'bankruptcy_stay',
  'attorney_represented', 'operator_block'
);

CREATE TYPE compliance_decision AS ENUM ('allow', 'deny', 'review');

CREATE TYPE txn_state AS ENUM (
  'qualified', 'offer', 'accepted', 'contract', 'title',
  'buyer_assigned', 'closing', 'paid', 'terminated'
);

CREATE TYPE ledger_direction AS ENUM ('cost', 'revenue');

CREATE TYPE ledger_category AS ENUM (
  'data_subscription', 'data_per_record', 'skiptrace', 'llm', 'voice',
  'sms', 'mail', 'human_research', 'title_escrow', 'legal', 'earnest_money',
  'marketing', 'other_vendor',
  'assignment_fee', 'recovery_fee', 'referral_fee', 'other_revenue'
);

CREATE TYPE actor_kind AS ENUM ('system', 'operator', 'agent', 'provider', 'migration');

CREATE TYPE action_kind AS ENUM (
  'call_seller', 'text_seller', 'email_seller', 'mail_seller',
  'skiptrace', 'verify_fact', 'human_review', 'make_offer',
  'send_buyer_package', 'verify_recovery', 'follow_up', 'wait', 'kill'
);

-- =====================================================================
-- 1. MARKETS, SOURCES, CONFIG, FLAGS
-- =====================================================================

CREATE TABLE markets (
  id              uuid PRIMARY KEY,
  key             text NOT NULL UNIQUE,              -- 'baltimore_city_md'
  display_name    text NOT NULL,
  state_code      char(2) NOT NULL,
  fips_county     text,
  timezone        text NOT NULL DEFAULT 'America/New_York',
  status          text NOT NULL DEFAULT 'pilot',      -- pilot|active|paused|retired
  activated_at    timestamptz,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb, -- see docs/market-config.md
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sources (
  id                uuid PRIMARY KEY,
  key               text NOT NULL UNIQUE,             -- 'baltimore.vbn'
  market_id         uuid REFERENCES markets(id),
  display_name      text NOT NULL,
  tier              source_tier NOT NULL,
  base_url          text,
  access_method     text NOT NULL,                    -- arcgis_rest|socrata|csv|api|manual_upload
  license_note      text,
  tos_url           text,
  scraping_allowed  boolean NOT NULL DEFAULT false,
  refresh_cron      text,
  base_confidence   numeric(5,4) NOT NULL DEFAULT 0.9000,
  cost_model        jsonb NOT NULL DEFAULT '{}'::jsonb, -- {"per_call_cents":0,"monthly_cents":0}
  enabled           boolean NOT NULL DEFAULT true,
  last_success_at   timestamptz,
  last_error_at     timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Raw payload archive. NEVER parse in place; normalize into facts.
CREATE TABLE source_fetches (
  id              uuid PRIMARY KEY,
  source_id       uuid NOT NULL REFERENCES sources(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  cursor_before   text,
  cursor_after    text,
  record_count    integer,
  bytes           bigint,
  http_status     integer,
  ok              boolean,
  error           text,
  cost_cents      integer NOT NULL DEFAULT 0,
  storage_uri     text                                 -- object-store path to raw blob
);
CREATE INDEX ON source_fetches (source_id, started_at DESC);

CREATE TABLE raw_records (
  id              uuid PRIMARY KEY,
  fetch_id        uuid NOT NULL REFERENCES source_fetches(id),
  source_id       uuid NOT NULL REFERENCES sources(id),
  source_record_id text,                               -- natural key at the source
  payload         jsonb NOT NULL,
  payload_hash    bytea NOT NULL,
  observed_at     timestamptz NOT NULL,
  normalized_at   timestamptz,
  normalize_error text
);
CREATE UNIQUE INDEX raw_records_dedupe ON raw_records (source_id, payload_hash);
CREATE INDEX ON raw_records (source_id, source_record_id);
CREATE INDEX ON raw_records (normalized_at) WHERE normalized_at IS NULL;

CREATE TABLE feature_flags (
  key           text PRIMARY KEY,                      -- 'engine.recovery', 'outbound.global'
  enabled       boolean NOT NULL DEFAULT false,
  market_id     uuid REFERENCES markets(id),
  note          text,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE spend_caps (
  id            uuid PRIMARY KEY,
  scope         text NOT NULL,                         -- 'global'|'market:<key>'|'category:<cat>'|'opportunity'
  period        text NOT NULL,                         -- 'day'|'week'|'month'|'lifetime'
  cap_cents     integer NOT NULL,
  hard_stop     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, period)
);

CREATE TABLE spend_counters (
  scope         text NOT NULL,
  period_start  date NOT NULL,
  period        text NOT NULL,
  spent_cents   integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, period, period_start)
);

-- =====================================================================
-- 2. PROPERTY / PARCEL / PERSON GRAPH
-- =====================================================================

CREATE TABLE properties (
  id                  uuid PRIMARY KEY,
  market_id           uuid NOT NULL REFERENCES markets(id),
  -- Canonical identity
  apn                 text,                            -- SDAT account id / block-lot
  blocklot            text,                            -- Baltimore City BLOCKLOT
  address_line1       text NOT NULL,
  address_line2       text,
  city                text NOT NULL,
  state_code          char(2) NOT NULL,
  postal_code         text,
  address_norm        text NOT NULL,                   -- USPS-normalized, uppercased, no punctuation
  address_hash        bytea NOT NULL,                  -- sha256(address_norm || postal_code)
  centroid            geometry(Point, 4326),
  -- Denormalized read-model (always derived from facts; never written directly by ingestors)
  property_type       text,
  year_built          integer,
  building_sqft       integer,
  lot_sqft            integer,
  beds                numeric(4,1),
  baths               numeric(4,1),
  zoning_code         text,
  last_sale_date      date,
  last_sale_price_cents bigint,
  assessed_value_cents  bigint,
  is_vacant_land      boolean NOT NULL DEFAULT false,
  read_model_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX properties_apn_key ON properties (market_id, apn) WHERE apn IS NOT NULL;
CREATE UNIQUE INDEX properties_address_key ON properties (market_id, address_hash);
CREATE INDEX properties_centroid_gix ON properties USING gist (centroid);
CREATE INDEX properties_addr_trgm ON properties USING gin (address_norm gin_trgm_ops);

CREATE TABLE parcels (
  id              uuid PRIMARY KEY,
  property_id     uuid REFERENCES properties(id),
  market_id       uuid NOT NULL REFERENCES markets(id),
  apn             text NOT NULL,
  geom            geometry(MultiPolygon, 4326),
  area_sqft       integer,
  frontage_ft     numeric(8,2),
  depth_ft        numeric(8,2),
  shape_ratio     numeric(6,3),                        -- area / bbox area; squareness proxy
  road_access     boolean,
  flood_zone      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX parcels_apn_key ON parcels (market_id, apn);
CREATE INDEX parcels_geom_gix ON parcels USING gist (geom);

-- Precomputed adjacency for cluster/assemblage analysis (cheap filter).
CREATE TABLE parcel_adjacency (
  parcel_id       uuid NOT NULL REFERENCES parcels(id),
  neighbor_id     uuid NOT NULL REFERENCES parcels(id),
  shared_edge_ft  numeric(8,2),
  PRIMARY KEY (parcel_id, neighbor_id)
);

CREATE TABLE persons (
  id                uuid PRIMARY KEY,
  kind              text NOT NULL DEFAULT 'individual', -- individual|entity
  display_name      text NOT NULL,
  name_norm         text NOT NULL,
  first_name        text,
  last_name         text,
  entity_name       text,
  entity_state      char(2),
  entity_registry_id text,                              -- SDAT entity id
  is_deceased       boolean NOT NULL DEFAULT false,
  identity_confidence numeric(5,4) NOT NULL DEFAULT 0.5,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX persons_name_trgm ON persons USING gin (name_norm gin_trgm_ops);
CREATE INDEX persons_entity_registry ON persons (entity_registry_id) WHERE entity_registry_id IS NOT NULL;

-- Resolves LLC -> officers, heirs, etc.
CREATE TABLE person_links (
  from_person_id  uuid NOT NULL REFERENCES persons(id),
  to_person_id    uuid NOT NULL REFERENCES persons(id),
  relation        text NOT NULL,                        -- officer_of|agent_for|spouse|heir|same_as
  confidence      numeric(5,4) NOT NULL,
  source_id       uuid REFERENCES sources(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_person_id, to_person_id, relation)
);

CREATE TABLE property_person_roles (
  id              uuid PRIMARY KEY,
  property_id     uuid NOT NULL REFERENCES properties(id),
  person_id       uuid NOT NULL REFERENCES persons(id),
  role            text NOT NULL,                        -- owner_of_record|co_owner|mortgagee|tenant|
                                                        -- personal_representative|receiver|lienholder
  ownership_pct   numeric(6,3),
  start_date      date,
  end_date        date,
  is_current      boolean NOT NULL DEFAULT true,
  source_id       uuid REFERENCES sources(id),
  confidence      numeric(5,4) NOT NULL DEFAULT 0.8,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON property_person_roles (property_id) WHERE is_current;
CREATE INDEX ON property_person_roles (person_id) WHERE is_current;

CREATE TABLE contacts (
  id                uuid PRIMARY KEY,
  person_id         uuid NOT NULL REFERENCES persons(id),
  kind              contact_kind NOT NULL,
  value_raw         text NOT NULL,
  value_norm        text NOT NULL,                      -- E.164 for phones, lowercased for email
  value_hash        bytea NOT NULL,
  confidence        numeric(5,4) NOT NULL,
  line_type         text,                               -- mobile|landline|voip (from carrier lookup)
  carrier           text,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_verified_at  timestamptz,
  last_good_at      timestamptz,                        -- last time it produced a real human
  bad_count         integer NOT NULL DEFAULT 0,
  source_id         uuid REFERENCES sources(id),
  cost_cents        integer NOT NULL DEFAULT 0,
  is_suppressed     boolean NOT NULL DEFAULT false,     -- denormalized from suppressions
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_person_value ON contacts (person_id, value_hash);
CREATE INDEX contacts_value_hash ON contacts (value_hash);

-- =====================================================================
-- 3. FACT LEDGER  (§8 "one piece of research, many uses")
-- =====================================================================
-- Predicate registry: every fact predicate must be declared here.
CREATE TABLE predicates (
  key             text PRIMARY KEY,                     -- 'vacancy.vbn_open'
  subject         subject_kind NOT NULL,
  value_schema    jsonb NOT NULL,                       -- JSON Schema for facts.value
  default_ttl_days integer,                             -- NULL = durable, never expires
  volatility      text NOT NULL DEFAULT 'durable',      -- durable|slow|volatile
  description     text,
  -- Resolution and projection policy. Persisted rather than read from config at runtime
  -- because §32 replay must reconstruct a decision from stored rows alone: a tolerance that
  -- lived only in a YAML file would make replay reflect today's config, not the config that
  -- actually decided the conflict.
  read_model_column text,                               -- properties.<column> this projects into
  tolerance       numeric,                              -- numeric predicates: |a-b| > tolerance is a conflict
  conflict_escalate boolean NOT NULL DEFAULT false      -- true = a human resolves, not the hierarchy
);

CREATE TABLE facts (
  id                uuid PRIMARY KEY,
  subject_type      subject_kind NOT NULL,
  subject_id        uuid NOT NULL,
  predicate         text NOT NULL REFERENCES predicates(key),
  value             jsonb NOT NULL,
  epistemic         epistemic_kind NOT NULL,
  source_id         uuid REFERENCES sources(id),
  source_record_id  text,
  raw_record_id     uuid REFERENCES raw_records(id),
  derived_from      uuid[],                             -- fact ids, for derived/inference
  observed_at       timestamptz NOT NULL,               -- when true in the world
  recorded_at       timestamptz NOT NULL DEFAULT now(), -- when Magnolia learned it
  expires_at        timestamptz,
  confidence        numeric(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  cost_cents        integer NOT NULL DEFAULT 0,
  superseded_by     uuid REFERENCES facts(id),
  is_current        boolean NOT NULL DEFAULT true
);
CREATE INDEX facts_subject ON facts (subject_type, subject_id, predicate) WHERE is_current;
-- At most one CURRENT fact per subject+predicate+source. Superseding (§8.1 rule 5) already
-- intends this; the index makes it structural rather than a matter of application discipline,
-- so a bug in recordFact or a concurrent write cannot produce two "current" facts from one
-- source. Conflicts (§8.3) are between DIFFERENT sources, so this does not suppress them.
CREATE UNIQUE INDEX facts_one_current_per_source
  ON facts (subject_type, subject_id, predicate, source_id) WHERE is_current;
CREATE INDEX facts_predicate_observed ON facts (predicate, observed_at DESC);
CREATE INDEX facts_expiring ON facts (expires_at) WHERE is_current AND expires_at IS NOT NULL;

-- Surfaced when two current facts on the same subject+predicate disagree (§8.3).
CREATE TABLE fact_conflicts (
  id              uuid PRIMARY KEY,
  subject_type    subject_kind NOT NULL,
  subject_id      uuid NOT NULL,
  predicate       text NOT NULL,
  fact_ids        uuid[] NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  resolution      text,                                 -- prefer_tier|prefer_recent|operator|unresolved
  resolved_fact_id uuid REFERENCES facts(id),
  resolved_by     text,
  resolved_at     timestamptz
);
CREATE INDEX ON fact_conflicts (resolved_at) WHERE resolved_at IS NULL;

-- =====================================================================
-- 4. SIGNALS
-- =====================================================================

CREATE TABLE signals (
  id              uuid PRIMARY KEY,
  property_id     uuid NOT NULL REFERENCES properties(id),
  signal_type     text NOT NULL,                        -- see docs/signal-registry.md
  is_active       boolean NOT NULL DEFAULT true,
  strength        numeric(5,4) NOT NULL DEFAULT 1.0,
  evidence_fact_ids uuid[] NOT NULL,
  opened_at       timestamptz NOT NULL,
  closed_at       timestamptz,
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX signals_active_key ON signals (property_id, signal_type) WHERE is_active;
CREATE INDEX ON signals (signal_type) WHERE is_active;

-- =====================================================================
-- 5. OPPORTUNITIES & ROUTES
-- =====================================================================

CREATE TABLE opportunities (
  id                uuid PRIMARY KEY,
  market_id         uuid NOT NULL REFERENCES markets(id),
  property_id       uuid NOT NULL REFERENCES properties(id),
  status            opportunity_status NOT NULL DEFAULT 'new',
  lifecycle         lifecycle_state NOT NULL DEFAULT 'created',
  cohort_key        text,                               -- §13 pattern that created it
  discovered_via    uuid REFERENCES sources(id),
  primary_person_id uuid REFERENCES persons(id),
  best_route_id     uuid,                               -- FK added after opportunity_routes
  rank_score        numeric(8,4) NOT NULL DEFAULT 0,
  spent_cents       integer NOT NULL DEFAULT 0,
  revenue_cents     integer NOT NULL DEFAULT 0,
  human_minutes     integer NOT NULL DEFAULT 0,
  first_contact_at  timestamptz,
  last_activity_at  timestamptz,
  stale_after       timestamptz,
  closed_at         timestamptz,
  close_reason      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON opportunities (market_id, status);
CREATE INDEX ON opportunities (rank_score DESC) WHERE status NOT IN ('dead','paid');
CREATE UNIQUE INDEX opportunities_open_per_property
  ON opportunities (property_id) WHERE status NOT IN ('dead','paid');

CREATE TABLE opportunity_routes (
  id                    uuid PRIMARY KEY,
  opportunity_id        uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  engine                engine_kind NOT NULL,
  state                 route_state NOT NULL DEFAULT 'candidate',
  -- Economics (§7). All model outputs, all versioned by score_config_version.
  payout_cents_p50      bigint,
  payout_cents_p10      bigint,
  payout_cents_p90      bigint,
  pursuit_cost_cents    integer,
  capital_required_cents bigint NOT NULL DEFAULT 0,
  p_pay                 numeric(5,4),
  days_to_cash_p50      integer,
  human_minutes_est     integer,
  confidence            numeric(5,4),
  ev_cents              bigint,                         -- p_pay*payout_p50 - pursuit_cost
  rank_score            numeric(8,4),
  score_config_version  text,
  scored_at             timestamptz,
  rejected_reason       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, engine)
);
ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_best_route_fk
  FOREIGN KEY (best_route_id) REFERENCES opportunity_routes(id);
CREATE INDEX ON opportunity_routes (engine, state, rank_score DESC);

CREATE TABLE score_runs (
  id                  uuid PRIMARY KEY,
  route_id            uuid NOT NULL REFERENCES opportunity_routes(id) ON DELETE CASCADE,
  config_version      text NOT NULL,
  trigger_event       text,
  inputs              jsonb NOT NULL,                   -- signal set + facts used
  outputs             jsonb NOT NULL,                   -- every component score
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON score_runs (route_id, created_at DESC);

-- =====================================================================
-- 6. NEXT ACTION SYSTEM (§23)
-- =====================================================================

CREATE TABLE next_actions (
  id                uuid PRIMARY KEY,
  opportunity_id    uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  route_id          uuid REFERENCES opportunity_routes(id),
  kind              action_kind NOT NULL,
  reason            text NOT NULL,                      -- exactly one human-readable reason
  due_at            timestamptz NOT NULL,
  requires_human    boolean NOT NULL DEFAULT false,
  est_cost_cents    integer NOT NULL DEFAULT 0,
  est_value_cents   bigint NOT NULL DEFAULT 0,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_open           boolean NOT NULL DEFAULT true,
  completed_at      timestamptz,
  outcome           text,
  superseded_by     uuid REFERENCES next_actions(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- Hard invariant: exactly one open next action per opportunity.
CREATE UNIQUE INDEX next_actions_one_open ON next_actions (opportunity_id) WHERE is_open;
CREATE INDEX ON next_actions (due_at) WHERE is_open;
CREATE INDEX ON next_actions (requires_human, due_at) WHERE is_open;

-- =====================================================================
-- 7. CONSENT, SUPPRESSION, COMPLIANCE
-- =====================================================================

CREATE TABLE consents (
  id              uuid PRIMARY KEY,
  person_id       uuid REFERENCES persons(id),
  contact_id      uuid REFERENCES contacts(id),
  contact_hash    bytea NOT NULL,                       -- works even before person resolution
  scope           consent_scope NOT NULL,
  granted         boolean NOT NULL,
  method          text NOT NULL,                        -- web_form|ivr_keypress|verbal_recorded|written|inbound_initiated
  evidence_uri    text,                                 -- recording or form submission artifact
  evidence_text   text,                                 -- exact disclosure language shown/spoken
  captured_at     timestamptz NOT NULL,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  revoked_method  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_lookup ON consents (contact_hash, scope, granted, revoked_at);

CREATE TABLE suppressions (
  id              uuid PRIMARY KEY,
  contact_hash    bytea NOT NULL,
  contact_value   text,                                 -- retained for operator debugging only
  scope           text NOT NULL DEFAULT 'all',          -- all|sms|voice|email|mail
  reason          suppression_reason NOT NULL,
  source          text,
  added_at        timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  note            text
);
CREATE UNIQUE INDEX suppressions_key ON suppressions (contact_hash, scope, reason);
CREATE INDEX ON suppressions (contact_hash);

CREATE TABLE compliance_checks (
  id                uuid PRIMARY KEY,
  policy_version    text NOT NULL,
  action_type       text NOT NULL,                      -- 'comm.send'|'txn.advance'|'spend.commit'
  subject_type      subject_kind,
  subject_id        uuid,
  opportunity_id    uuid REFERENCES opportunities(id),
  decision          compliance_decision NOT NULL,
  rules_evaluated   jsonb NOT NULL,                     -- [{rule, result, detail}]
  blocking_rules    text[],
  reviewed_by       text,
  reviewed_at       timestamptz,
  review_outcome    compliance_decision,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON compliance_checks (decision, created_at DESC);
CREATE INDEX ON compliance_checks (opportunity_id);

-- =====================================================================
-- 8. COMMUNICATIONS & CONVERSATIONS
-- =====================================================================

CREATE TABLE comm_templates (
  id              uuid PRIMARY KEY,
  key             text NOT NULL,
  channel         comm_channel NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  body            text NOT NULL,
  required_disclosures text[] NOT NULL DEFAULT '{}',
  approved_by     text,
  approved_at     timestamptz,
  is_active       boolean NOT NULL DEFAULT false,
  experiment_id   uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);

CREATE TABLE communications (
  id                  uuid PRIMARY KEY,
  opportunity_id      uuid REFERENCES opportunities(id),
  person_id           uuid REFERENCES persons(id),
  contact_id          uuid REFERENCES contacts(id),
  direction           comm_direction NOT NULL,
  channel             comm_channel NOT NULL,
  provider            text,                             -- 'twilio'|'bland'|'lob'|'postmark'
  provider_message_id text,
  template_id         uuid REFERENCES comm_templates(id),
  variant_key         text,
  compliance_check_id uuid REFERENCES compliance_checks(id),
  status              comm_status NOT NULL DEFAULT 'queued',
  scheduled_for       timestamptz,
  sent_at             timestamptz,
  completed_at        timestamptz,
  duration_seconds    integer,
  body                text,
  recording_uri       text,
  recording_consent_id uuid REFERENCES consents(id),
  transcript_uri      text,
  cost_cents          integer NOT NULL DEFAULT 0,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- Invariant enforced in app + trigger: outbound rows MUST have compliance_check_id.
CREATE INDEX ON communications (opportunity_id, created_at DESC);
CREATE INDEX ON communications (contact_id, created_at DESC);
CREATE INDEX ON communications (status, scheduled_for) WHERE status IN ('queued','sending');

CREATE TABLE conversation_extractions (
  id                  uuid PRIMARY KEY,
  communication_id    uuid NOT NULL REFERENCES communications(id),
  opportunity_id      uuid REFERENCES opportunities(id),
  extractor_version   text NOT NULL,
  motivation          text,                             -- none|low|medium|high
  timeline_days       integer,
  condition_grade     text,                             -- turnkey|light|moderate|heavy|teardown
  occupancy           text,                             -- vacant|owner|tenant|unknown
  seller_price_cents  bigint,
  reason              text,
  other_decision_maker boolean,
  open_to_offer       boolean,
  requested_followup_at timestamptz,
  do_not_contact      boolean NOT NULL DEFAULT false,
  raw                 jsonb NOT NULL,
  confidence          numeric(5,4),
  needs_human_review  boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON conversation_extractions (opportunity_id, created_at DESC);

-- =====================================================================
-- 9. BUYER INTELLIGENCE
-- =====================================================================

CREATE TABLE buyers (
  id                  uuid PRIMARY KEY,
  market_id           uuid NOT NULL REFERENCES markets(id),
  person_id           uuid REFERENCES persons(id),
  display_name        text NOT NULL,
  company_name        text,
  buyer_type          text NOT NULL,                    -- flipper|landlord|builder|land|ibuyer|owner_occupant
  is_active           boolean NOT NULL DEFAULT true,
  contactability      numeric(5,4) NOT NULL DEFAULT 0.5,
  reliability_score   numeric(5,4),                     -- observed close rate on our deals
  deals_offered       integer NOT NULL DEFAULT 0,
  deals_accepted      integer NOT NULL DEFAULT 0,
  deals_closed        integer NOT NULL DEFAULT 0,
  deals_fell_through  integer NOT NULL DEFAULT 0,
  last_activity_at    timestamptz,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- What they SAY they buy. Lower confidence by construction.
CREATE TABLE buyer_stated_criteria (
  id              uuid PRIMARY KEY,
  buyer_id        uuid NOT NULL REFERENCES buyers(id),
  criteria        jsonb NOT NULL,                       -- {price:[min,max], beds:[..], zips:[..], types:[..]}
  stated_at       timestamptz NOT NULL,
  stated_via      text,
  confidence      numeric(5,4) NOT NULL DEFAULT 0.4
);

-- What they ACTUALLY bought. Higher confidence, drives matching.
CREATE TABLE buyer_purchases (
  id              uuid PRIMARY KEY,
  buyer_id        uuid NOT NULL REFERENCES buyers(id),
  property_id     uuid REFERENCES properties(id),
  purchase_date   date NOT NULL,
  price_cents     bigint,
  property_type   text,
  beds            numeric(4,1),
  baths           numeric(4,1),
  building_sqft   integer,
  lot_sqft        integer,
  zip             text,
  neighborhood    text,
  is_land         boolean NOT NULL DEFAULT false,
  resold_date     date,
  resold_price_cents bigint,
  source_id       uuid REFERENCES sources(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON buyer_purchases (buyer_id, purchase_date DESC);
CREATE INDEX ON buyer_purchases (zip, purchase_date DESC);

-- Derived buy-box, recomputed on buyer_purchases change.
CREATE TABLE buyer_observed_profiles (
  buyer_id            uuid PRIMARY KEY REFERENCES buyers(id),
  price_p10_cents     bigint,
  price_p50_cents     bigint,
  price_p90_cents     bigint,
  zips                text[],
  neighborhoods       text[],
  property_types      text[],
  beds_min            numeric(4,1),
  beds_max            numeric(4,1),
  sqft_min            integer,
  sqft_max            integer,
  buys_land           boolean NOT NULL DEFAULT false,
  purchase_count_24mo integer NOT NULL DEFAULT 0,
  median_days_to_close integer,
  recomputed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE buyer_matches (
  id              uuid PRIMARY KEY,
  route_id        uuid NOT NULL REFERENCES opportunity_routes(id) ON DELETE CASCADE,
  buyer_id        uuid NOT NULL REFERENCES buyers(id),
  score           numeric(5,4) NOT NULL,
  evidence        jsonb NOT NULL,                       -- which comparable purchases drove the score
  presented_at    timestamptz,
  response        text,                                 -- interested|pass|no_response
  response_reason text,
  responded_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, buyer_id)
);
CREATE INDEX ON buyer_matches (route_id, score DESC);

-- =====================================================================
-- 10. TRANSACTIONS (§19)
-- =====================================================================

CREATE TABLE transactions (
  id                  uuid PRIMARY KEY,
  opportunity_id      uuid NOT NULL REFERENCES opportunities(id),
  route_id            uuid NOT NULL REFERENCES opportunity_routes(id),
  engine              engine_kind NOT NULL,
  state               txn_state NOT NULL DEFAULT 'qualified',
  seller_person_id    uuid REFERENCES persons(id),
  buyer_id            uuid REFERENCES buyers(id),
  contract_price_cents bigint,
  assignment_fee_cents bigint,
  expected_close_date date,
  actual_close_date   date,
  title_company       text,
  closing_attorney    text,                             -- MD: deed must be attorney-prepared
  state_entered_at    timestamptz NOT NULL DEFAULT now(),
  deadline_at         timestamptz,
  owner_operator      text,
  terminated_reason   text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON transactions (state, deadline_at);

CREATE TABLE transaction_transitions (
  id                uuid PRIMARY KEY,
  transaction_id    uuid NOT NULL REFERENCES transactions(id),
  from_state        txn_state,
  to_state          txn_state NOT NULL,
  actor_kind        actor_kind NOT NULL,
  actor_id          text,
  authorized_by     text,                               -- required for binding transitions
  compliance_check_id uuid REFERENCES compliance_checks(id),
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Gate artifacts. A transition is blocked until all required artifacts exist.
CREATE TABLE transaction_artifacts (
  id                uuid PRIMARY KEY,
  transaction_id    uuid NOT NULL REFERENCES transactions(id),
  artifact_key      text NOT NULL,                      -- see docs/transaction-gates.md
  storage_uri       text,
  signed_at         timestamptz,
  signed_by         text,
  verified_by       text,
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, artifact_key)
);

-- =====================================================================
-- 11. LEDGER (§28, §29)
-- =====================================================================

CREATE TABLE ledger_entries (
  id                uuid PRIMARY KEY,
  direction         ledger_direction NOT NULL,
  category          ledger_category NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),
  opportunity_id    uuid REFERENCES opportunities(id),
  route_id          uuid REFERENCES opportunity_routes(id),
  transaction_id    uuid REFERENCES transactions(id),
  market_id         uuid REFERENCES markets(id),
  vendor            text,
  external_ref      text,
  memo              text,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (opportunity_id);
CREATE INDEX ON ledger_entries (occurred_at DESC);
CREATE INDEX ON ledger_entries (market_id, direction, occurred_at DESC);

-- =====================================================================
-- 12. OUTCOMES & LEARNING (§30, §32)
-- =====================================================================

CREATE TABLE outcomes (
  id                    uuid PRIMARY KEY,
  opportunity_id        uuid NOT NULL REFERENCES opportunities(id),
  route_id              uuid REFERENCES opportunity_routes(id),
  transaction_id        uuid REFERENCES transactions(id),
  engine                engine_kind NOT NULL,
  succeeded             boolean NOT NULL,
  paid_amount_cents     bigint NOT NULL DEFAULT 0,
  total_cost_cents      bigint NOT NULL DEFAULT 0,
  net_cents             bigint NOT NULL DEFAULT 0,
  paid_at               timestamptz,
  days_to_cash          integer,
  human_minutes         integer,
  failure_stage         text,
  failure_reason        text,
  -- prediction snapshot at qualification, for calibration
  predicted_p_pay       numeric(5,4),
  predicted_payout_cents bigint,
  predicted_days        integer,
  predicted_cost_cents  integer,
  score_config_version  text,
  lessons               text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON outcomes (engine, created_at DESC);

CREATE TABLE calibration_buckets (
  id                uuid PRIMARY KEY,
  engine            engine_kind NOT NULL,
  config_version    text NOT NULL,
  bucket_low        numeric(5,4) NOT NULL,
  bucket_high       numeric(5,4) NOT NULL,
  n                 integer NOT NULL,
  predicted_mean    numeric(5,4) NOT NULL,
  actual_rate       numeric(5,4) NOT NULL,
  computed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiments (
  id              uuid PRIMARY KEY,
  key             text NOT NULL UNIQUE,
  hypothesis      text NOT NULL,
  unit            text NOT NULL,                        -- opportunity|contact|property
  variants        jsonb NOT NULL,                       -- [{key, weight}]
  min_sample      integer NOT NULL,
  started_at      timestamptz,
  stopped_at      timestamptz,
  result          jsonb
);

CREATE TABLE experiment_assignments (
  experiment_id   uuid NOT NULL REFERENCES experiments(id),
  unit_id         uuid NOT NULL,
  variant_key     text NOT NULL,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, unit_id)
);

-- =====================================================================
-- 13. EVENT BUS (transactional outbox) & AUDIT
-- =====================================================================

CREATE TABLE events (
  id              uuid PRIMARY KEY,
  topic           text NOT NULL,                        -- see docs/events.md
  subject_type    subject_kind,
  subject_id      uuid,
  payload         jsonb NOT NULL,
  dedupe_key      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text
);
CREATE UNIQUE INDEX events_dedupe ON events (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX events_unpublished ON events (created_at) WHERE published_at IS NULL;

CREATE TABLE audit_log (
  id              uuid PRIMARY KEY,
  actor_kind      actor_kind NOT NULL,
  actor_id        text,
  action          text NOT NULL,
  subject_type    subject_kind,
  subject_id      uuid,
  before          jsonb,
  after           jsonb,
  reason          text,
  policy_version  text,
  request_id      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (subject_type, subject_id, created_at DESC);
CREATE INDEX ON audit_log (created_at DESC);

-- =====================================================================
-- 14. OPERATORS
-- =====================================================================

CREATE TABLE operators (
  id              uuid PRIMARY KEY,
  email           text NOT NULL UNIQUE,
  display_name    text NOT NULL,
  role            text NOT NULL DEFAULT 'operator',     -- operator|admin|readonly
  can_authorize_binding boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY,
  operator_id     uuid NOT NULL REFERENCES operators(id),
  token_hash      bytea NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
