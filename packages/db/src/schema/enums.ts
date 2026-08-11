import { pgEnum } from 'drizzle-orm/pg-core';

/** The 19 enums from `schema.sql` §0, in declaration order. Values must match exactly. */

export const epistemicKind = pgEnum('epistemic_kind', ['fact', 'prediction', 'inference']);

export const subjectKind = pgEnum('subject_kind', [
  'property',
  'parcel',
  'person',
  'organization',
  'contact',
  'buyer',
  'opportunity',
  'transaction',
]);

export const sourceTier = pgEnum('source_tier', [
  'official_record',
  'commercial_data',
  'secondary',
  'derived',
  'ai_inference',
  'human',
]);

export const engineKind = pgEnum('engine_kind', ['wholesale', 'land', 'recovery']);

export const opportunityStatus = pgEnum('opportunity_status', [
  'new',
  'qualified',
  'contacting',
  'engaged',
  'negotiating',
  'contracted',
  'monetizing',
  'closing',
  'paid',
  'dead',
  'nurture',
]);

export const routeState = pgEnum('route_state', [
  'candidate',
  'active',
  'preserved',
  'rejected',
  'won',
  'lost',
]);

export const lifecycleState = pgEnum('lifecycle_state', [
  'created',
  'active',
  'aging',
  'stale',
  'recycled',
  'closed',
]);

export const commChannel = pgEnum('comm_channel', [
  'voice_human',
  'voice_ai',
  'sms',
  'email',
  'mail',
  'in_person',
]);

export const commDirection = pgEnum('comm_direction', ['outbound', 'inbound']);

export const commStatus = pgEnum('comm_status', [
  'blocked',
  'queued',
  'sending',
  'sent',
  'delivered',
  'failed',
  'bounced',
  'answered',
  'no_answer',
  'voicemail',
  'replied',
]);

export const contactKind = pgEnum('contact_kind', [
  'phone_mobile',
  'phone_landline',
  'phone_unknown',
  'email',
  'mailing_address',
]);

export const consentScope = pgEnum('consent_scope', [
  'sms_marketing',
  'sms_transactional',
  'ai_voice',
  'call_recording',
  'email_marketing',
  'prerecorded_voice',
]);

export const suppressionReason = pgEnum('suppression_reason', [
  'federal_dnc',
  'state_dnc',
  'internal_dnc',
  'consumer_revocation',
  'litigator_list',
  'wrong_number',
  'deceased',
  'bankruptcy_stay',
  'attorney_represented',
  'operator_block',
]);

export const complianceDecision = pgEnum('compliance_decision', ['allow', 'deny', 'review']);

export const txnState = pgEnum('txn_state', [
  'qualified',
  'offer',
  'accepted',
  'contract',
  'title',
  'buyer_assigned',
  'closing',
  'paid',
  'terminated',
]);

export const ledgerDirection = pgEnum('ledger_direction', ['cost', 'revenue']);

export const ledgerCategory = pgEnum('ledger_category', [
  'data_subscription',
  'data_per_record',
  'skiptrace',
  'llm',
  'voice',
  'sms',
  'mail',
  'human_research',
  'title_escrow',
  'legal',
  'earnest_money',
  'marketing',
  'other_vendor',
  'assignment_fee',
  'recovery_fee',
  'referral_fee',
  'other_revenue',
]);

export const actorKind = pgEnum('actor_kind', [
  'system',
  'operator',
  'agent',
  'provider',
  'migration',
]);

export const actionKind = pgEnum('action_kind', [
  'call_seller',
  'text_seller',
  'email_seller',
  'mail_seller',
  'skiptrace',
  'verify_fact',
  'human_review',
  'make_offer',
  'send_buyer_package',
  'verify_recovery',
  'follow_up',
  'wait',
  'kill',
]);
