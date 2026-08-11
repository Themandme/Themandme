-- Extensions. schema.sql declares these at the top of the file; drizzle-kit does not emit
-- them, so they are prepended here to keep the migration self-sufficient. Without postgis
-- the geometry columns fail, and without pg_trgm the address/name GIN indexes fail.
CREATE EXTENSION IF NOT EXISTS "postgis";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."action_kind" AS ENUM('call_seller', 'text_seller', 'email_seller', 'mail_seller', 'skiptrace', 'verify_fact', 'human_review', 'make_offer', 'send_buyer_package', 'verify_recovery', 'follow_up', 'wait', 'kill');--> statement-breakpoint
CREATE TYPE "public"."actor_kind" AS ENUM('system', 'operator', 'agent', 'provider', 'migration');--> statement-breakpoint
CREATE TYPE "public"."comm_channel" AS ENUM('voice_human', 'voice_ai', 'sms', 'email', 'mail', 'in_person');--> statement-breakpoint
CREATE TYPE "public"."comm_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."comm_status" AS ENUM('blocked', 'queued', 'sending', 'sent', 'delivered', 'failed', 'bounced', 'answered', 'no_answer', 'voicemail', 'replied');--> statement-breakpoint
CREATE TYPE "public"."compliance_decision" AS ENUM('allow', 'deny', 'review');--> statement-breakpoint
CREATE TYPE "public"."consent_scope" AS ENUM('sms_marketing', 'sms_transactional', 'ai_voice', 'call_recording', 'email_marketing', 'prerecorded_voice');--> statement-breakpoint
CREATE TYPE "public"."contact_kind" AS ENUM('phone_mobile', 'phone_landline', 'phone_unknown', 'email', 'mailing_address');--> statement-breakpoint
CREATE TYPE "public"."engine_kind" AS ENUM('wholesale', 'land', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."epistemic_kind" AS ENUM('fact', 'prediction', 'inference');--> statement-breakpoint
CREATE TYPE "public"."ledger_category" AS ENUM('data_subscription', 'data_per_record', 'skiptrace', 'llm', 'voice', 'sms', 'mail', 'human_research', 'title_escrow', 'legal', 'earnest_money', 'marketing', 'other_vendor', 'assignment_fee', 'recovery_fee', 'referral_fee', 'other_revenue');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('cost', 'revenue');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_state" AS ENUM('created', 'active', 'aging', 'stale', 'recycled', 'closed');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('new', 'qualified', 'contacting', 'engaged', 'negotiating', 'contracted', 'monetizing', 'closing', 'paid', 'dead', 'nurture');--> statement-breakpoint
CREATE TYPE "public"."route_state" AS ENUM('candidate', 'active', 'preserved', 'rejected', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."source_tier" AS ENUM('official_record', 'commercial_data', 'secondary', 'derived', 'ai_inference', 'human');--> statement-breakpoint
CREATE TYPE "public"."subject_kind" AS ENUM('property', 'parcel', 'person', 'organization', 'contact', 'buyer', 'opportunity', 'transaction');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('federal_dnc', 'state_dnc', 'internal_dnc', 'consumer_revocation', 'litigator_list', 'wrong_number', 'deceased', 'bankruptcy_stay', 'attorney_represented', 'operator_block');--> statement-breakpoint
CREATE TYPE "public"."txn_state" AS ENUM('qualified', 'offer', 'accepted', 'contract', 'title', 'buyer_assigned', 'closing', 'paid', 'terminated');--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"market_id" uuid,
	"note" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"state_code" char(2) NOT NULL,
	"fips_county" text,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"status" text DEFAULT 'pilot' NOT NULL,
	"activated_at" timestamp with time zone,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "raw_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fetch_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_record_id" text,
	"payload" jsonb NOT NULL,
	"payload_hash" "bytea" NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"normalized_at" timestamp with time zone,
	"normalize_error" text
);
--> statement-breakpoint
CREATE TABLE "source_fetches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"cursor_before" text,
	"cursor_after" text,
	"record_count" integer,
	"bytes" bigint,
	"http_status" integer,
	"ok" boolean,
	"error" text,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"storage_uri" text
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"market_id" uuid,
	"display_name" text NOT NULL,
	"tier" "source_tier" NOT NULL,
	"base_url" text,
	"access_method" text NOT NULL,
	"license_note" text,
	"tos_url" text,
	"scraping_allowed" boolean DEFAULT false NOT NULL,
	"refresh_cron" text,
	"base_confidence" numeric(5, 4) DEFAULT 0.9 NOT NULL,
	"cost_model" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "spend_caps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"period" text NOT NULL,
	"cap_cents" integer NOT NULL,
	"hard_stop" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_caps_scope_period_key" UNIQUE("scope","period")
);
--> statement-breakpoint
CREATE TABLE "spend_counters" (
	"scope" text NOT NULL,
	"period_start" date NOT NULL,
	"period" text NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_counters_pkey" PRIMARY KEY("scope","period","period_start")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" "contact_kind" NOT NULL,
	"value_raw" text NOT NULL,
	"value_norm" text NOT NULL,
	"value_hash" "bytea" NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"line_type" text,
	"carrier" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_good_at" timestamp with time zone,
	"bad_count" integer DEFAULT 0 NOT NULL,
	"source_id" uuid,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"is_suppressed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parcel_adjacency" (
	"parcel_id" uuid NOT NULL,
	"neighbor_id" uuid NOT NULL,
	"shared_edge_ft" numeric(8, 2),
	CONSTRAINT "parcel_adjacency_pkey" PRIMARY KEY("parcel_id","neighbor_id")
);
--> statement-breakpoint
CREATE TABLE "parcels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid,
	"market_id" uuid NOT NULL,
	"apn" text NOT NULL,
	"geom" geometry(MultiPolygon,4326),
	"area_sqft" integer,
	"frontage_ft" numeric(8, 2),
	"depth_ft" numeric(8, 2),
	"shape_ratio" numeric(6, 3),
	"road_access" boolean,
	"flood_zone" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_links" (
	"from_person_id" uuid NOT NULL,
	"to_person_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_links_pkey" PRIMARY KEY("from_person_id","to_person_id","relation")
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'individual' NOT NULL,
	"display_name" text NOT NULL,
	"name_norm" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"entity_name" text,
	"entity_state" char(2),
	"entity_registry_id" text,
	"is_deceased" boolean DEFAULT false NOT NULL,
	"identity_confidence" numeric(5, 4) DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"apn" text,
	"blocklot" text,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"state_code" char(2) NOT NULL,
	"postal_code" text,
	"address_norm" text NOT NULL,
	"address_hash" "bytea" NOT NULL,
	"centroid" geometry(Point,4326),
	"property_type" text,
	"year_built" integer,
	"building_sqft" integer,
	"lot_sqft" integer,
	"beds" numeric(4, 1),
	"baths" numeric(4, 1),
	"zoning_code" text,
	"last_sale_date" date,
	"last_sale_price_cents" bigint,
	"assessed_value_cents" bigint,
	"is_vacant_land" boolean DEFAULT false NOT NULL,
	"read_model_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_person_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"ownership_pct" numeric(6, 3),
	"start_date" date,
	"end_date" date,
	"is_current" boolean DEFAULT true NOT NULL,
	"source_id" uuid,
	"confidence" numeric(5, 4) DEFAULT 0.8 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_conflicts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_type" "subject_kind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"predicate" text NOT NULL,
	"fact_ids" uuid[] NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution" text,
	"resolved_fact_id" uuid,
	"resolved_by" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_type" "subject_kind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"predicate" text NOT NULL,
	"value" jsonb NOT NULL,
	"epistemic" "epistemic_kind" NOT NULL,
	"source_id" uuid NOT NULL,
	"source_record_id" text,
	"raw_record_id" uuid,
	"derived_from" uuid[],
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"confidence" numeric(5, 4) NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"superseded_by" uuid,
	"is_current" boolean DEFAULT true NOT NULL,
	CONSTRAINT "facts_confidence_check" CHECK ("facts"."confidence" >= 0 AND "facts"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "predicates" (
	"key" text PRIMARY KEY NOT NULL,
	"subject" "subject_kind" NOT NULL,
	"value_schema" jsonb NOT NULL,
	"default_ttl_days" integer,
	"volatility" text DEFAULT 'durable' NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "next_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"route_id" uuid,
	"kind" "action_kind" NOT NULL,
	"reason" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"requires_human" boolean DEFAULT false NOT NULL,
	"est_cost_cents" integer DEFAULT 0 NOT NULL,
	"est_value_cents" bigint DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_open" boolean DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" text,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"status" "opportunity_status" DEFAULT 'new' NOT NULL,
	"lifecycle" "lifecycle_state" DEFAULT 'created' NOT NULL,
	"cohort_key" text,
	"discovered_via" uuid,
	"primary_person_id" uuid,
	"best_route_id" uuid,
	"rank_score" numeric(8, 4) DEFAULT 0 NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"human_minutes" integer DEFAULT 0 NOT NULL,
	"first_contact_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"stale_after" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"engine" "engine_kind" NOT NULL,
	"state" "route_state" DEFAULT 'candidate' NOT NULL,
	"payout_cents_p50" bigint,
	"payout_cents_p10" bigint,
	"payout_cents_p90" bigint,
	"pursuit_cost_cents" integer,
	"capital_required_cents" bigint DEFAULT 0 NOT NULL,
	"p_pay" numeric(5, 4),
	"days_to_cash_p50" integer,
	"human_minutes_est" integer,
	"confidence" numeric(5, 4),
	"ev_cents" bigint,
	"rank_score" numeric(8, 4),
	"score_config_version" text,
	"scored_at" timestamp with time zone,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_routes_opportunity_id_engine_key" UNIQUE("opportunity_id","engine")
);
--> statement-breakpoint
CREATE TABLE "score_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"route_id" uuid NOT NULL,
	"config_version" text NOT NULL,
	"trigger_event" text,
	"inputs" jsonb NOT NULL,
	"outputs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"property_id" uuid NOT NULL,
	"signal_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"strength" numeric(5, 4) DEFAULT 1 NOT NULL,
	"evidence_fact_ids" uuid[] NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"last_confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comm_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"channel" "comm_channel" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"body" text NOT NULL,
	"required_disclosures" text[] DEFAULT '{}' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"is_active" boolean DEFAULT false NOT NULL,
	"experiment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"opportunity_id" uuid,
	"person_id" uuid,
	"contact_id" uuid,
	"direction" "comm_direction" NOT NULL,
	"channel" "comm_channel" NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"template_id" uuid,
	"variant_key" text,
	"compliance_check_id" uuid,
	"status" "comm_status" DEFAULT 'queued' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_seconds" integer,
	"body" text,
	"recording_uri" text,
	"recording_consent_id" uuid,
	"transcript_uri" text,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"policy_version" text NOT NULL,
	"action_type" text NOT NULL,
	"subject_type" "subject_kind",
	"subject_id" uuid,
	"opportunity_id" uuid,
	"decision" "compliance_decision" NOT NULL,
	"rules_evaluated" jsonb NOT NULL,
	"blocking_rules" text[],
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_outcome" "compliance_decision",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid,
	"contact_id" uuid,
	"contact_hash" "bytea" NOT NULL,
	"scope" "consent_scope" NOT NULL,
	"granted" boolean NOT NULL,
	"method" text NOT NULL,
	"evidence_uri" text,
	"evidence_text" text,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_method" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_extractions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"communication_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"extractor_version" text NOT NULL,
	"motivation" text,
	"timeline_days" integer,
	"condition_grade" text,
	"occupancy" text,
	"seller_price_cents" bigint,
	"reason" text,
	"other_decision_maker" boolean,
	"open_to_offer" boolean,
	"requested_followup_at" timestamp with time zone,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"raw" jsonb NOT NULL,
	"confidence" numeric(5, 4),
	"needs_human_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_hash" "bytea" NOT NULL,
	"contact_value" text,
	"scope" text DEFAULT 'all' NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"source" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "buyer_matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"route_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"score" numeric(5, 4) NOT NULL,
	"evidence" jsonb NOT NULL,
	"presented_at" timestamp with time zone,
	"response" text,
	"response_reason" text,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyer_matches_route_id_buyer_id_key" UNIQUE("route_id","buyer_id")
);
--> statement-breakpoint
CREATE TABLE "buyer_observed_profiles" (
	"buyer_id" uuid PRIMARY KEY NOT NULL,
	"price_p10_cents" bigint,
	"price_p50_cents" bigint,
	"price_p90_cents" bigint,
	"zips" text[],
	"neighborhoods" text[],
	"property_types" text[],
	"beds_min" numeric(4, 1),
	"beds_max" numeric(4, 1),
	"sqft_min" integer,
	"sqft_max" integer,
	"buys_land" boolean DEFAULT false NOT NULL,
	"purchase_count_24mo" integer DEFAULT 0 NOT NULL,
	"median_days_to_close" integer,
	"recomputed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buyer_purchases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"buyer_id" uuid NOT NULL,
	"property_id" uuid,
	"purchase_date" date NOT NULL,
	"price_cents" bigint,
	"property_type" text,
	"beds" numeric(4, 1),
	"baths" numeric(4, 1),
	"building_sqft" integer,
	"lot_sqft" integer,
	"zip" text,
	"neighborhood" text,
	"is_land" boolean DEFAULT false NOT NULL,
	"resold_date" date,
	"resold_price_cents" bigint,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buyer_stated_criteria" (
	"id" uuid PRIMARY KEY NOT NULL,
	"buyer_id" uuid NOT NULL,
	"criteria" jsonb NOT NULL,
	"stated_at" timestamp with time zone NOT NULL,
	"stated_via" text,
	"confidence" numeric(5, 4) DEFAULT 0.4 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buyers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"person_id" uuid,
	"display_name" text NOT NULL,
	"company_name" text,
	"buyer_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"contactability" numeric(5, 4) DEFAULT 0.5 NOT NULL,
	"reliability_score" numeric(5, 4),
	"deals_offered" integer DEFAULT 0 NOT NULL,
	"deals_accepted" integer DEFAULT 0 NOT NULL,
	"deals_closed" integer DEFAULT 0 NOT NULL,
	"deals_fell_through" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"category" "ledger_category" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"opportunity_id" uuid,
	"route_id" uuid,
	"transaction_id" uuid,
	"market_id" uuid,
	"vendor" text,
	"external_ref" text,
	"memo" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_cents_check" CHECK ("ledger_entries"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transaction_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"artifact_key" text NOT NULL,
	"storage_uri" text,
	"signed_at" timestamp with time zone,
	"signed_by" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_artifacts_transaction_id_artifact_key_key" UNIQUE("transaction_id","artifact_key")
);
--> statement-breakpoint
CREATE TABLE "transaction_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"from_state" "txn_state",
	"to_state" "txn_state" NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_id" text,
	"authorized_by" text,
	"compliance_check_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"engine" "engine_kind" NOT NULL,
	"state" "txn_state" DEFAULT 'qualified' NOT NULL,
	"seller_person_id" uuid,
	"buyer_id" uuid,
	"contract_price_cents" bigint,
	"assignment_fee_cents" bigint,
	"expected_close_date" date,
	"actual_close_date" date,
	"title_company" text,
	"closing_attorney" text,
	"state_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone,
	"owner_operator" text,
	"terminated_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"subject_type" "subject_kind",
	"subject_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"policy_version" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibration_buckets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"engine" "engine_kind" NOT NULL,
	"config_version" text NOT NULL,
	"bucket_low" numeric(5, 4) NOT NULL,
	"bucket_high" numeric(5, 4) NOT NULL,
	"n" integer NOT NULL,
	"predicted_mean" numeric(5, 4) NOT NULL,
	"actual_rate" numeric(5, 4) NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"subject_type" "subject_kind",
	"subject_id" uuid,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "experiment_assignments" (
	"experiment_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"variant_key" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiment_assignments_pkey" PRIMARY KEY("experiment_id","unit_id")
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"hypothesis" text NOT NULL,
	"unit" text NOT NULL,
	"variants" jsonb NOT NULL,
	"min_sample" integer NOT NULL,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"result" jsonb,
	CONSTRAINT "experiments_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'operator' NOT NULL,
	"can_authorize_binding" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"route_id" uuid,
	"transaction_id" uuid,
	"engine" "engine_kind" NOT NULL,
	"succeeded" boolean NOT NULL,
	"paid_amount_cents" bigint DEFAULT 0 NOT NULL,
	"total_cost_cents" bigint DEFAULT 0 NOT NULL,
	"net_cents" bigint DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"days_to_cash" integer,
	"human_minutes" integer,
	"failure_stage" text,
	"failure_reason" text,
	"predicted_p_pay" numeric(5, 4),
	"predicted_payout_cents" bigint,
	"predicted_days" integer,
	"predicted_cost_cents" integer,
	"score_config_version" text,
	"lessons" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_records" ADD CONSTRAINT "raw_records_fetch_id_source_fetches_id_fk" FOREIGN KEY ("fetch_id") REFERENCES "public"."source_fetches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_records" ADD CONSTRAINT "raw_records_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_fetches" ADD CONSTRAINT "source_fetches_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcel_adjacency" ADD CONSTRAINT "parcel_adjacency_parcel_id_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcel_adjacency" ADD CONSTRAINT "parcel_adjacency_neighbor_id_parcels_id_fk" FOREIGN KEY ("neighbor_id") REFERENCES "public"."parcels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_links" ADD CONSTRAINT "person_links_from_person_id_persons_id_fk" FOREIGN KEY ("from_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_links" ADD CONSTRAINT "person_links_to_person_id_persons_id_fk" FOREIGN KEY ("to_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_links" ADD CONSTRAINT "person_links_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_person_roles" ADD CONSTRAINT "property_person_roles_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_person_roles" ADD CONSTRAINT "property_person_roles_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_person_roles" ADD CONSTRAINT "property_person_roles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_conflicts" ADD CONSTRAINT "fact_conflicts_resolved_fact_id_facts_id_fk" FOREIGN KEY ("resolved_fact_id") REFERENCES "public"."facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_predicate_predicates_key_fk" FOREIGN KEY ("predicate") REFERENCES "public"."predicates"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_raw_record_id_raw_records_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "public"."raw_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_superseded_by_facts_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_actions" ADD CONSTRAINT "next_actions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_actions" ADD CONSTRAINT "next_actions_route_id_opportunity_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."opportunity_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_actions" ADD CONSTRAINT "next_actions_superseded_by_next_actions_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."next_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_discovered_via_sources_id_fk" FOREIGN KEY ("discovered_via") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_primary_person_id_persons_id_fk" FOREIGN KEY ("primary_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_best_route_id_opportunity_routes_id_fk" FOREIGN KEY ("best_route_id") REFERENCES "public"."opportunity_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_routes" ADD CONSTRAINT "opportunity_routes_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_runs" ADD CONSTRAINT "score_runs_route_id_opportunity_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."opportunity_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_template_id_comm_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."comm_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_compliance_check_id_compliance_checks_id_fk" FOREIGN KEY ("compliance_check_id") REFERENCES "public"."compliance_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_recording_consent_id_consents_id_fk" FOREIGN KEY ("recording_consent_id") REFERENCES "public"."consents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_checks" ADD CONSTRAINT "compliance_checks_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_extractions" ADD CONSTRAINT "conversation_extractions_communication_id_communications_id_fk" FOREIGN KEY ("communication_id") REFERENCES "public"."communications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_extractions" ADD CONSTRAINT "conversation_extractions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_matches" ADD CONSTRAINT "buyer_matches_route_id_opportunity_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."opportunity_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_matches" ADD CONSTRAINT "buyer_matches_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_observed_profiles" ADD CONSTRAINT "buyer_observed_profiles_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_purchases" ADD CONSTRAINT "buyer_purchases_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_purchases" ADD CONSTRAINT "buyer_purchases_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_purchases" ADD CONSTRAINT "buyer_purchases_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_stated_criteria" ADD CONSTRAINT "buyer_stated_criteria_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyers" ADD CONSTRAINT "buyers_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyers" ADD CONSTRAINT "buyers_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_route_id_opportunity_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."opportunity_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_artifacts" ADD CONSTRAINT "transaction_artifacts_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_transitions" ADD CONSTRAINT "transaction_transitions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_transitions" ADD CONSTRAINT "transaction_transitions_compliance_check_id_compliance_checks_id_fk" FOREIGN KEY ("compliance_check_id") REFERENCES "public"."compliance_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_route_id_opportunity_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."opportunity_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_seller_person_id_persons_id_fk" FOREIGN KEY ("seller_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_route_id_opportunity_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."opportunity_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "raw_records_dedupe" ON "raw_records" USING btree ("source_id","payload_hash");--> statement-breakpoint
CREATE INDEX "raw_records_source_id_source_record_id_idx" ON "raw_records" USING btree ("source_id","source_record_id");--> statement-breakpoint
CREATE INDEX "raw_records_normalized_at_idx" ON "raw_records" USING btree ("normalized_at") WHERE "raw_records"."normalized_at" is null;--> statement-breakpoint
CREATE INDEX "source_fetches_source_id_started_at_idx" ON "source_fetches" USING btree ("source_id","started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_person_value" ON "contacts" USING btree ("person_id","value_hash");--> statement-breakpoint
CREATE INDEX "contacts_value_hash" ON "contacts" USING btree ("value_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "parcels_apn_key" ON "parcels" USING btree ("market_id","apn");--> statement-breakpoint
CREATE INDEX "parcels_geom_gix" ON "parcels" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "persons_name_trgm" ON "persons" USING gin ("name_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "persons_entity_registry" ON "persons" USING btree ("entity_registry_id") WHERE "persons"."entity_registry_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "properties_apn_key" ON "properties" USING btree ("market_id","apn") WHERE "properties"."apn" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "properties_address_key" ON "properties" USING btree ("market_id","address_hash");--> statement-breakpoint
CREATE INDEX "properties_centroid_gix" ON "properties" USING gist ("centroid");--> statement-breakpoint
CREATE INDEX "properties_addr_trgm" ON "properties" USING gin ("address_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "property_person_roles_property_id_idx" ON "property_person_roles" USING btree ("property_id") WHERE "property_person_roles"."is_current";--> statement-breakpoint
CREATE INDEX "property_person_roles_person_id_idx" ON "property_person_roles" USING btree ("person_id") WHERE "property_person_roles"."is_current";--> statement-breakpoint
CREATE INDEX "fact_conflicts_resolved_at_idx" ON "fact_conflicts" USING btree ("resolved_at") WHERE "fact_conflicts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "facts_subject" ON "facts" USING btree ("subject_type","subject_id","predicate") WHERE "facts"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "facts_one_current_per_source" ON "facts" USING btree ("subject_type","subject_id","predicate","source_id") WHERE "facts"."is_current";--> statement-breakpoint
CREATE INDEX "facts_predicate_observed" ON "facts" USING btree ("predicate","observed_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "facts_expiring" ON "facts" USING btree ("expires_at") WHERE "facts"."is_current" and "facts"."expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "next_actions_one_open" ON "next_actions" USING btree ("opportunity_id") WHERE "next_actions"."is_open";--> statement-breakpoint
CREATE INDEX "next_actions_due_at_idx" ON "next_actions" USING btree ("due_at") WHERE "next_actions"."is_open";--> statement-breakpoint
CREATE INDEX "next_actions_requires_human_due_at_idx" ON "next_actions" USING btree ("requires_human","due_at") WHERE "next_actions"."is_open";--> statement-breakpoint
CREATE INDEX "opportunities_market_id_status_idx" ON "opportunities" USING btree ("market_id","status");--> statement-breakpoint
CREATE INDEX "opportunities_rank_score_idx" ON "opportunities" USING btree ("rank_score" DESC NULLS FIRST) WHERE "opportunities"."status" not in ('dead','paid');--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_open_per_property" ON "opportunities" USING btree ("property_id") WHERE "opportunities"."status" not in ('dead','paid');--> statement-breakpoint
CREATE INDEX "opportunity_routes_engine_state_rank_score_idx" ON "opportunity_routes" USING btree ("engine","state","rank_score" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "score_runs_route_id_created_at_idx" ON "score_runs" USING btree ("route_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "signals_active_key" ON "signals" USING btree ("property_id","signal_type") WHERE "signals"."is_active";--> statement-breakpoint
CREATE INDEX "signals_signal_type_idx" ON "signals" USING btree ("signal_type") WHERE "signals"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "comm_templates_key_version_key" ON "comm_templates" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "communications_opportunity_id_created_at_idx" ON "communications" USING btree ("opportunity_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "communications_contact_id_created_at_idx" ON "communications" USING btree ("contact_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "communications_status_scheduled_for_idx" ON "communications" USING btree ("status","scheduled_for") WHERE "communications"."status" in ('queued','sending');--> statement-breakpoint
CREATE INDEX "compliance_checks_decision_created_at_idx" ON "compliance_checks" USING btree ("decision","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "compliance_checks_opportunity_id_idx" ON "compliance_checks" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "consents_lookup" ON "consents" USING btree ("contact_hash","scope","granted","revoked_at");--> statement-breakpoint
CREATE INDEX "conversation_extractions_opportunity_id_created_at_idx" ON "conversation_extractions" USING btree ("opportunity_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_key" ON "suppressions" USING btree ("contact_hash","scope","reason");--> statement-breakpoint
CREATE INDEX "suppressions_contact_hash_idx" ON "suppressions" USING btree ("contact_hash");--> statement-breakpoint
CREATE INDEX "buyer_matches_route_id_score_idx" ON "buyer_matches" USING btree ("route_id","score" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "buyer_purchases_buyer_id_purchase_date_idx" ON "buyer_purchases" USING btree ("buyer_id","purchase_date" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "buyer_purchases_zip_purchase_date_idx" ON "buyer_purchases" USING btree ("zip","purchase_date" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ledger_entries_opportunity_id_idx" ON "ledger_entries" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_occurred_at_idx" ON "ledger_entries" USING btree ("occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "ledger_entries_market_id_direction_occurred_at_idx" ON "ledger_entries" USING btree ("market_id","direction","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "transactions_state_deadline_at_idx" ON "transactions" USING btree ("state","deadline_at");--> statement-breakpoint
CREATE INDEX "audit_log_subject_type_subject_id_created_at_idx" ON "audit_log" USING btree ("subject_type","subject_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "events_dedupe" ON "events" USING btree ("dedupe_key") WHERE "events"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "events_unpublished" ON "events" USING btree ("created_at") WHERE "events"."published_at" is null;--> statement-breakpoint
CREATE INDEX "outcomes_engine_created_at_idx" ON "outcomes" USING btree ("engine","created_at" DESC NULLS FIRST);