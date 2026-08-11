# Magnolia V1 — Technical Specification

**Derived from:** Magnolia Baltimore V1 Business & Product Blueprint
**Status:** Build-ready. Business design frozen for V1 except where §2 notes a required change.
**Market:** Baltimore City, Maryland
**Companion files:** `schema.sql`, `BUILD_PLAN.md`, `CLAUDE.md`

---

## 1. How to read this document

This spec is written to be handed directly to Claude Code. It is opinionated on purpose: where the blueprint left a choice open, this document picks one so the build does not stall on design debate.

Three levels of requirement language:

- **MUST** — a violation is a bug or a legal exposure. Enforce in code and in tests.
- **SHOULD** — the intended design; deviate only with a written note in the PR.
- **MAY** — optional, or deferred past V1.

Anything marked **[VERIFY]** is a fact about the outside world (an endpoint, a statute, a vendor term) that the developer or the operator MUST confirm before the code that depends on it goes live. Endpoints move and laws change. Do not treat this document as the system of record for the outside world.

---

## 2. Required changes to the business plan

Four items in the blueprint cannot be built as written. These are not style preferences; each one is either illegal, or it creates liability that dwarfs the revenue it produces. The architecture below already reflects the corrections.

### 2.1 AI voice cannot be the cold-outreach channel

The blueprint's §16 makes AI voice qualification the primary first touch to property owners. In February 2024 the FCC declared that AI-generated voices are "artificial" voices under the TCPA, which means an AI voice call to a residential or mobile line requires the called party's prior express consent (prior express *written* consent where the call is telemarketing). Statutory damages run $500–$1,500 per call with no aggregate cap, and a cold-call list of distressed homeowners is exactly the fact pattern plaintiffs' firms look for. **[VERIFY current FCC state of play before enabling any voice automation — there is active litigation and rulemaking in this area, including a pending NPRM on AI-call disclosure.]**

**V1 design consequence:**

- Outbound **cold** contact channels are: **direct mail** and **operator-dialed voice**. That is it.
- **SMS** is permitted only to a contact with a recorded, unexpired consent of scope `sms_marketing`, and only if not suppressed.
- **AI voice** (`voice_ai`) is permitted only on: (a) **inbound** calls to a Magnolia-published number, or (b) outbound calls to a contact with a recorded `ai_voice` consent — which in practice means a callback the person asked for.
- Every AI voice call MUST open with an AI disclosure and, separately, a recording-consent request (see §2.2).

This is not a downgrade of the product. It relocates the AI from "cold dialer" to "always-available inbound qualifier," which is where it performs better anyway: the person who calls the number on a mailer is pre-qualified by the act of calling.

The comms layer (§10) is built so that flipping cold AI voice on later — if consent capture at scale becomes viable — is a config change, not a rewrite.

### 2.2 Maryland is an all-party consent state for call recording

Maryland's Wiretap Act (Md. Cts. & Jud. Proc. § 10-402) requires the consent of all parties to record a private conversation. **[VERIFY with counsel.]** Any recorded call MUST capture consent at the top of the call, and the consent artifact MUST be linked from `communications.recording_consent_id`. If consent is declined, recording MUST stop and the call MUST continue unrecorded — the extractor then works from operator notes, not a transcript.

### 2.3 Pre-foreclosure outreach is the highest-liability cohort, not the easiest

The blueprint's §13 pattern #2 ("fresh pre-foreclosure + equity") sits directly inside the Maryland Protection of Homeowners in Foreclosure Act (PHIFA, Md. Real Prop. §§ 7-301 et seq.). PHIFA attaches once a homeowner's mortgage is at least 60 days in default. A person who contacts that homeowner and offers services related to the default — including arranging a sale of the property — can be classified as a "foreclosure consultant," which triggers mandatory contract terms, a rescission right, a bar on collecting any compensation before full performance, and a bar on acquiring any interest in the residence from a homeowner they contracted with. Violations carry treble damages, fees, and criminal exposure. **[VERIFY scope and current text with a Maryland real estate attorney before enabling.]**

**V1 design consequence:** the `pre_foreclosure_equity` cohort ships **disabled**, behind feature flag `cohort.pre_foreclosure`. The ingestion and scoring for it can be built — knowing a property is in foreclosure is a legitimate input to valuation and to *not* contacting someone. What is gated is outreach. The flag MUST NOT be enabled without a written attorney sign-off recorded in `audit_log`.

### 2.4 Maryland's wholesaler disclosure and attorney-close requirements are transaction gates

Effective October 1, 2025, Maryland requires a written disclosure when a wholesaler will assign a contract to purchase residential real estate (Md. Real Prop. § 10-715, from HB 124 / SB 160). Separately, Md. Real Prop. § 3-104(f)(1) requires that a deed be prepared by a Maryland attorney or by a party to the transaction. **[VERIFY both.]**

**V1 design consequence:** these become blocking artifacts in the transaction state machine (§11.3), not reminders. `contract` cannot be entered without `md_wholesale_disclosure_pre_contract`. `buyer_assigned` cannot be entered without `md_wholesale_disclosure_pre_assignment`. `closing` cannot be entered without `closing_attorney` populated.

### 2.5 A note on the recovery engine

The blueprint's §5.3 treats small surplus-fund recoveries as fast, cheap bootstrap cash. Be careful here. Maryland foreclosure surplus is generally distributed under the supervision of the circuit court that ratified the sale, and third parties who locate claimants and charge a fee for that service are a regulated category in many states, with fee caps and disclosure requirements — and the activity can look like the "foreclosure consultant" conduct PHIFA restricts. **[VERIFY specifically: whether Magnolia can charge a finder's fee for surplus recovery in Maryland, under what cap, and with what contract terms. This is a question for counsel, not for the internet.]**

**V1 design consequence:** build the recovery engine's *identification and verification* stages (they are cheap, and the data is public). Ship the *outreach* stage behind feature flag `engine.recovery.outreach`, default off. Recovery routes may be scored, ranked, and displayed; they may not be contacted until the flag is on.

---

## 3. Stack and topology

Deliberately boring, single-region, cheap to run. Target infrastructure cost at V1 scale (≤ 100k properties, ≤ 2k opportunities): **under $80/month**.

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x, Node 22 LTS | One language across API, workers, dashboard |
| Repo | pnpm workspace monorepo | `apps/*`, `packages/*` |
| DB | PostgreSQL 16 + PostGIS 3.4 | Single instance. Also the queue's backing store. |
| ORM/migrations | Drizzle + drizzle-kit | `schema.sql` is the review artifact; Drizzle is the source of migrations |
| Queue | BullMQ on Redis | Repeatable jobs for cron-style ingestion |
| API | Fastify + zod | REST/JSON, OpenAPI generated from zod |
| Dashboard | Next.js 15 App Router + Tailwind | Server components; no separate BFF |
| Object storage | S3-compatible (Cloudflare R2) | Raw payloads, recordings, PDFs |
| LLM | Anthropic API (`claude-sonnet-4-6` default, Haiku for classification) | Behind `LlmProvider` |
| Hosting | Single VPS or Fly.io: 1 API, 1 worker, 1 Postgres, 1 Redis | |
| Observability | Structured JSON logs + Sentry + `/health` | No APM vendor in V1 |

### 3.1 Package layout

```
apps/
  api/              Fastify server, REST + webhooks
  worker/           BullMQ processors, schedulers
  web/              Next.js operator dashboard
packages/
  db/               Drizzle schema, migrations, typed queries
  core/             Domain types, fact ledger, signal engine, scoring, router
  providers/        Adapter interfaces + implementations (data, comms, skiptrace, llm)
  compliance/       Rule engine + Maryland rule pack. NO other package may bypass it.
  config/           Zod-validated market/scoring/policy config loaders
  testkit/          Fixtures, factories, fake providers, golden files
```

### 3.2 Environments

`local` (docker-compose, all providers faked) → `staging` (real read-only data sources, **all outbound comms hard-disabled**) → `production`.

**MUST:** In `local` and `staging`, `CommsProvider` implementations are physically absent from the DI container. Blocking outbound must not depend on a runtime flag being set correctly.

---

## 4. Data architecture

### 4.1 The fact ledger

Everything Magnolia believes about the world is a row in `facts`. This is the mechanism that satisfies blueprint §8.1 (one piece of research, many uses) and §8.2 (fact vs. prediction vs. inference).

A fact is: `(subject_type, subject_id, predicate, value, epistemic, source, observed_at, confidence)`.

**Rules:**

1. **MUST** — ingestors write only to `raw_records`. Normalizers write to `facts`. Nothing else writes to `facts`.
2. **MUST** — every fact carries `source_id`, `observed_at`, and `confidence`. There is no default source. A fact with no provenance is a bug.
3. **MUST** — `epistemic` is set by the producer and never changes. An LLM output is `inference`, always. A model estimate is `prediction`, always. Only a producer whose source tier is `official_record`, `commercial_data`, or `human` may write `fact`.
4. **MUST** — the property/parcel/person tables' scalar columns (`year_built`, `zoning_code`, etc.) are a **read model**. They are recomputed from current facts. No service writes them directly. This is what keeps "the address says vacant but the read model says occupied" from becoming an unresolvable mystery.
5. **SHOULD** — superseding is explicit: when a new fact replaces an old one for the same subject+predicate from the same source, set `superseded_by` and `is_current = false` on the old row. History is never deleted.
6. **MUST** — when two *current* facts on the same subject+predicate disagree beyond a per-predicate tolerance, write a `fact_conflicts` row instead of silently picking. The resolver applies the source hierarchy (§4.2) and records which rule it used. Conflicts on predicates in the `conflict.escalate` list go to a human.

**Predicate registry.** Every predicate is declared in `predicates` with a JSON Schema, a volatility class, and a default TTL. Writing a fact with an unregistered predicate MUST throw. Volatility drives refresh:

| Class | Examples | TTL | Refresh |
|---|---|---|---|
| `durable` | year built, lot size, parcel geometry | none | on source change only |
| `slow` | ownership, zoning, assessed value | 180d | monthly source sync |
| `volatile` | vacancy notice status, tax delinquency balance, listing status | 30d | on event, plus weekly sweep |

### 4.2 Source hierarchy and conflict resolution

Resolution order, highest first: `official_record` → `commercial_data` → `secondary` → `derived` → `ai_inference`. Within a tier, prefer the more recent `observed_at`. `human` overrides everything and is recorded with the operator's id.

An `ai_inference` fact **MUST NOT** by itself justify: spending money over $1.00, sending an outbound communication, or advancing a transaction state. It can raise a score and it can trigger a verification action.

### 4.3 Entity resolution

**Properties** resolve on, in order: (1) `market_id + apn`, (2) `market_id + address_hash`, (3) fuzzy address match (`pg_trgm` similarity ≥ 0.92) **plus** a confirming attribute (parcel centroid within 50m, or matching owner name). Below that, create a new property and emit `property.possible_duplicate` for review. Never auto-merge on fuzzy alone.

**Persons** resolve on: entity registry id; then exact normalized name + a shared mailing address or a shared property; then fuzzy name ≥ 0.95 + shared property. Person merges are reversible: keep `person_links` rows with `relation = 'same_as'` rather than destroying rows.

**MUST:** entity resolution is idempotent. Re-running ingestion over the same source data produces zero new properties and zero new persons.

### 4.4 Signals

A signal is a *durable, decision-relevant condition* on a property, derived from facts by a pure function. Signals are opened and closed, never mutated. `signals.evidence_fact_ids` is required and is what the deal-replay view renders.

V1 signal registry (`packages/core/src/signals/registry.ts`):

| `signal_type` | Opens when | Closes when | Strength input |
|---|---|---|---|
| `vacancy.vbn_open` | open Vacant Building Notice fact exists | notice cancelled/abated | days open |
| `tax.on_sale_list` | property appears on current tax lien sale list | removed / redeemed | delinquent amount ÷ assessed value |
| `tax.delinquent` | delinquent balance fact > $0 | balance = 0 | balance ÷ assessed value |
| `code.violation_open` | ≥1 open code enforcement citation | all closed | count, age |
| `code.receivership` | receivership petition fact | case closed | 1.0 |
| `owner.absentee` | owner mailing address ≠ property address | addresses match | distance band |
| `owner.long_hold` | last sale date > 15y ago | new sale | years ÷ 30, capped |
| `owner.entity` | owner is an entity | — | 1.0 |
| `owner.out_of_state` | owner mailing state ≠ MD | — | 1.0 |
| `owner.deceased_probable` | probate/estate indicator | — | source-dependent |
| `land.vacant_lot` | no structure + land-use code in lot set | structure appears | — |
| `land.adjacent_cluster` | ≥2 adjacent parcels share an owner | — | parcel count |
| `distress.multi` | ≥3 distinct distress signals active | drops below 3 | count |
| `foreclosure.filed` | foreclosure docket fact | dismissed / sold | — |

**`foreclosure.filed` MUST set `opportunities.contact_block_reason = 'phifa_review'` and force any open next action to `human_review`.** See §2.3.

### 4.5 Baltimore V1 data sources

All **[VERIFY]** — confirm the endpoint, the schema, the update cadence, and the terms of use before wiring each one. Build each as a `DataSourceAdapter` (§9.1) with a recorded golden fixture so schema drift breaks a test, not production.

| `sources.key` | What | Access | Cadence |
|---|---|---|---|
| `baltimore.vbn` | Vacant Building Notices | ArcGIS FeatureServer on `egisdata.baltimorecity.gov` (DHCD Open Baltimore datasets) — daily updates | daily |
| `baltimore.tax_sale` | Tax Lien Certificate Sale Properties | Open Baltimore (`data.baltimorecity.gov`) dataset; also the annual Tax Sale Book at `pay.baltimorecity.gov/TaxBooklet` | weekly in season, else monthly |
| `baltimore.code_violations` | Code enforcement / housing citations | Open Baltimore | daily |
| `baltimore.311` | Service requests (vacant, rodent, debris — occupancy proxies) | Open Baltimore | daily |
| `baltimore.permits` | Building permits (rehab activity, builder identification) | Open Baltimore | daily |
| `baltimore.open_bid` | Open Bid List / Vacants to Value (city-owned inventory) | Open Baltimore | weekly |
| `baltimore.real_property` | City real property / assessments extract | Open Baltimore | monthly |
| `md.sdat_parcel_points` | SDAT parcel ownership, valuation, structure attributes, statewide | MD iMAP `geodata.md.gov` `PlanningCadastre/MD_PropertyData` — sourced from SDAT monthly | monthly |
| `md.parcel_boundaries` | Statewide parcel polygons | MD iMAP `PlanningCadastre/MD_ParcelBoundaries` | quarterly |
| `md.sdat_entities` | Business entity lookup (LLC → officers/agent) | SDAT business search | on demand |
| `md.land_records` | Deeds, mortgages, liens | mdlandrec.net (account required) | on demand |
| `md.case_search` | Foreclosure and other case dockets | Maryland Judiciary Case Search | on demand |

**Access rules — MUST:**

- Prefer bulk download or documented REST/API access over HTML scraping in every case. Baltimore City's open data guidance asks consumers not to scrape and to use bulk download instead.
- **Maryland Judiciary Case Search:** its terms restrict automated/bulk extraction. **[VERIFY the current terms.]** Until verified in writing, `md.case_search` MUST be configured `scraping_allowed = false` and used only via manual operator lookup recorded as a `human`-tier fact.
- **mdlandrec.net:** access is credentialed and terms-restricted. Same treatment. **[VERIFY.]**
- Every adapter sets a descriptive `User-Agent` with a contact address, respects `robots.txt`, and rate-limits to ≤ 1 request/second per host by default.
- A source whose `scraping_allowed = false` and whose `access_method = 'manual_upload'` is a legitimate V1 pattern. Manual operator lookup with recorded provenance beats an automated ToS violation.

---

## 5. Cheap-first processing pipeline

Blueprint §9. Implemented as an explicit staged pipeline with a cost gate between every stage. The gate is not advisory — it is a function call that can throw `BudgetExceeded` or `EvGateFailed`.

```
T0  FREE / DETERMINISTIC   bulk ingest, normalize, signal derivation, rule scoring
T1  CHEAP AUTOMATION       geometry ops, adjacency, buyer matching, comparable lookup
T2  AI REASONING           LLM summarization, briefing generation, extraction
T3  PAID DATA              skip trace, phone validation, title/lien pull
T4  HUMAN                  operator review, operator dial, attorney review
```

### 5.1 The gate

```ts
// packages/core/src/pipeline/gate.ts
interface StageRequest {
  stage: 'T1' | 'T2' | 'T3' | 'T4';
  opportunityId: string;
  routeId?: string;
  estimatedCostCents: number;
  expectedValueDeltaCents: number;   // how much this stage improves EV
  reason: string;
}

// MUST: throws BudgetExceeded or EvGateFailed. Never returns a soft "false"
// that a caller can ignore. Every allow writes an audit_log row.
async function requestStage(req: StageRequest): Promise<StageGrant>;
```

Gate rules, in order:

1. **Kill switch.** If `feature_flags['stage.<n>']` is off, or `feature_flags['outbound.global']` is off for T4 comms, deny.
2. **Spend caps.** Check `spend_caps` for `global`, `market:<key>`, `category:<cat>`, and per-opportunity lifetime. Any `hard_stop` cap exceeded → deny.
3. **EV gate.** `expectedValueDeltaCents >= estimatedCostCents * evMultiple` where `evMultiple` defaults to 3.0 (config: `scoring.gate.ev_multiple`). Rationale: our probability estimates are bad early, so demand a wide margin.
4. **Per-opportunity ceiling.** Cumulative `opportunities.spent_cents` MUST NOT exceed `min(route.payout_p50 * 0.15, market.config.max_spend_per_opportunity_cents)`.
5. **Staleness.** T3/T4 denied if the driving signal set is older than `market.config.max_signal_age_days`.

### 5.2 Concrete cost discipline

- **T0 processes everything.** All ~200k Baltimore parcels can pass through T0 for essentially zero marginal cost. Do not filter early on the free tier — filter *after* it.
- **T2 (LLM) MUST be batched and cached.** Cache key: `hash(prompt_template_version + normalized_inputs)`. A repeated request for an unchanged property MUST NOT hit the API. Target: LLM cost per qualified opportunity under $0.10.
- **T2 model routing:** classification and extraction → Haiku. Briefing generation and multi-fact synthesis → Sonnet. Never call a model where a rule works: "is the owner's mailing address different from the property address" is string comparison, not inference.
- **T3 is the expensive tier.** Skip trace is per-lookup priced. A skip trace MUST NOT be requested until the route's `rank_score` clears `scoring.gate.skiptrace_min_rank` **and** no usable contact already exists on the person.
- **Land screening (blueprint §10):** the entire cheap screen is one SQL query over `parcels` + `signals` (size, zoning, road access, shape ratio, flood zone, adjacency). Deep analysis only runs for parcels that survive it *and* have ≥1 builder match above threshold.

---

## 6. Scoring and the monetization router

### 6.1 Philosophy

V1 scoring is **deterministic, configuration-driven, and legible**. No ML. Every score is reproducible from `score_runs.inputs` + the config version. The purpose of V1 is to generate the outcome data that would make a model possible later; a model trained on zero closed deals is theater.

### 6.2 Configuration

`config/scoring/v1.yaml`, loaded and zod-validated at boot, version string embedded in every `score_runs` and `opportunity_routes` row.

```yaml
version: "2026.08.01"
gate:
  ev_multiple: 3.0
  skiptrace_min_rank: 40
  ai_briefing_min_rank: 55
bootstrap:
  # §14: probability and speed dominate payout size.
  weights:
    p_pay: 0.40
    speed: 0.25
    cost: 0.20
    human_effort: 0.10
    payout: 0.05
  speed_halflife_days: 30       # speed_score = 0.5 ^ (days/halflife)
  payout_log_base: 10           # payout_score = log(payout_usd)/log(base), capped at 1
signals:
  weights:
    vacancy.vbn_open: 0.25
    tax.on_sale_list: 0.22
    tax.delinquent: 0.15
    code.receivership: 0.20
    code.violation_open: 0.10
    owner.absentee: 0.12
    owner.out_of_state: 0.08
    owner.long_hold: 0.08
    owner.entity: 0.05
    land.adjacent_cluster: 0.15
  combination: bounded_sum       # 1 - prod(1 - w_i * strength_i)
engines:
  wholesale:
    base_p_pay: 0.06             # cold outreach → closed assignment, honest prior
    min_spread_cents: 250000
    default_days_to_cash: 45
    default_human_minutes: 120
  land:
    base_p_pay: 0.04
    default_days_to_cash: 60
    default_human_minutes: 90
    require_buyer_match: true
  recovery:
    base_p_pay: 0.20
    default_days_to_cash: 60
    default_human_minutes: 60
    outreach_enabled: false      # §2.5
```

**MUST:** `base_p_pay` values are priors, and they are deliberately pessimistic. They are replaced by observed rates as soon as a calibration bucket has n ≥ 30 (§13.2). Do not let anyone tune these upward to make the dashboard look better.

### 6.3 Scoring a route

For each `(opportunity, engine)`:

```
distress      = bounded_sum(signal weights × strengths)
contactability= f(best contact confidence, line type, suppression state)
buyer_fit     = max(buyer_match.score) or 0
p_pay         = clamp(base_p_pay × (1 + distress) × (0.5 + 0.5×contactability) × (0.6 + 0.4×buyer_fit), 0, 0.95)
payout_p50    = engine-specific (see 6.4)
pursuit_cost  = sum(projected stage costs for the planned action sequence)
ev_cents      = p_pay × payout_p50 − pursuit_cost
rank_score    = 100 × Σ(weight_i × normalized_component_i)   # bootstrap weights above
```

**MUST:** `rank_score` uses the bootstrap weights, so a $100 / 95% / 7-day / $5-cost recovery outranks a $10,000 / 30% / 90-day / $200-cost wholesale — the worked example from blueprint §14 MUST be an executable test case (`packages/core/src/scoring/__tests__/bootstrap-ranking.test.ts`).

### 6.4 Payout estimation by engine

- **Wholesale:** `payout = (buyer_willing_price − seller_expectation − closing_costs) × assignment_capture`, where `buyer_willing_price` comes from matched buyers' observed purchase distribution for comparable properties, and `assignment_capture` defaults to 1.0 for assignment fee. Before a seller conversation, `seller_expectation` is a `prediction` derived from assessed value and comparable sales — mark it as such, and widen p10/p90 accordingly.
- **Land:** builder-match-driven. Without a matched builder above threshold, `payout = null` and the route stays `candidate`. Never score a land route on hypothetical demand.
- **Recovery:** `payout = verified_surplus × allowable_fee_rate`. `allowable_fee_rate` is **[VERIFY — statutory cap, see §2.5]** and lives in market config, not in code. If the surplus amount is `prediction` rather than `fact`, the route MUST NOT advance past `candidate`.

### 6.5 Router

Every route is scored. The router picks one `active` route and marks the rest `preserved`. This is the mechanism behind blueprint §22.

**MUST:**
- Exactly one route per opportunity may be `active`.
- Marking a route `rejected` requires a `rejected_reason`. Preserved routes are re-evaluated on every re-score, so a route can come back.
- Route switching is an audited event (`route.switched`) with before/after.
- A route whose engine's feature flag is off may be scored and displayed but MUST NOT be activated.

---

## 7. Opportunity lifecycle

### 7.1 Status vs. lifecycle

Two orthogonal dimensions, deliberately:

- `status` — where the deal is (`new` … `paid`/`dead`). Drives the pipeline board.
- `lifecycle` — how alive it is (`created` → `active` → `aging` → `stale` → `recycled` → `closed`). Drives cost control.

Transitions: no activity for `market.config.aging_days` (default 14) → `aging`; `stale_days` (default 45) → `stale`. A **stale opportunity stops consuming paid stages entirely** — T0/T1 only. A new signal on a stale opportunity emits `opportunity.reactivated`, resets lifecycle to `active`, and creates a fresh next action. Nothing is deleted (blueprint §25).

### 7.2 The next-action invariant

Every opportunity with `status NOT IN ('dead','paid')` MUST have exactly one open `next_actions` row. Enforced by the partial unique index in `schema.sql` plus a nightly reconciliation job that alerts on violations.

Creating a new action MUST close the previous one with an `outcome`, and set `superseded_by`. The action's `reason` is a single sentence rendered verbatim in the dashboard; it MUST reference the specific evidence ("VBN open 412 days, owner mailing address in Florida") not a category ("high distress score").

`kind = 'wait'` is a legitimate outcome, and it MUST carry a `due_at` — waiting forever is how pipelines rot. `kind = 'kill'` requires a reason and writes an `outcomes` row with `succeeded = false`.

---

## 8. Compliance engine

`packages/compliance` is the only package permitted to authorize an outbound communication, a binding transaction transition, or a spend commitment above $1.00. Every other package calls it. **MUST:** no other package imports a comms provider directly. Enforce with an ESLint `no-restricted-imports` rule and a CI check.

### 8.1 Interface

```ts
interface ComplianceRequest {
  actionType: 'comm.send' | 'txn.advance' | 'spend.commit' | 'data.fetch';
  channel?: CommChannel;
  contactId?: string;
  personId?: string;
  opportunityId?: string;
  transactionId?: string;
  targetState?: TxnState;
  amountCents?: number;
  templateId?: string;
  at: Date;
}

interface ComplianceResult {
  decision: 'allow' | 'deny' | 'review';
  checkId: string;              // FK written to communications/transitions
  blockingRules: string[];
  requiredDisclosures: string[]; // MUST be present in the rendered message
  evaluated: RuleResult[];
}
```

**MUST:** `communications.compliance_check_id` is NOT NULL for every outbound row, enforced by a DB trigger, not just app code.

### 8.2 Maryland rule pack (V1)

Each rule is a pure function with its own unit tests and a citation comment. `policy_version` is bumped on any change and recorded on every check.

| Rule | Applies to | Behavior |
|---|---|---|
| `suppression.list` | all comms | Deny if `suppressions` matches `contact_hash` and scope. |
| `dnc.federal` | voice, sms | Deny unless an EBR or express consent is on file. **[VERIFY DNC scrubbing vendor + registration.]** |
| `consent.sms` | sms | Deny without unexpired, unrevoked `sms_marketing` consent. |
| `consent.ai_voice` | voice_ai outbound | Deny without `ai_voice` consent. Inbound is exempt. (§2.1) |
| `disclosure.ai_voice` | voice_ai | Require AI disclosure in opening script. |
| `consent.recording` | any recorded call | Require all-party consent capture; MD § 10-402. (§2.2) |
| `calling.window` | voice, sms | Deny outside 08:00–21:00 in the *called party's* timezone. |
| `frequency.cap` | all comms | Deny above `market.config.max_touches_per_person_per_week` (default 3) or `..._per_day` (default 1). |
| `phifa.gate` | all comms | Deny if `foreclosure.filed` signal active or mortgage-default indicator present, unless `cohort.pre_foreclosure` flag on AND attorney sign-off recorded. (§2.3) |
| `recovery.outreach` | all comms on recovery routes | Deny unless `engine.recovery.outreach` flag on. (§2.5) |
| `txn.disclosure.pre_contract` | txn.advance → `contract` | Deny without `md_wholesale_disclosure_pre_contract` artifact. (§2.4) |
| `txn.disclosure.pre_assignment` | txn.advance → `buyer_assigned` | Deny without `md_wholesale_disclosure_pre_assignment` artifact. |
| `txn.attorney_close` | txn.advance → `closing` | Deny without `closing_attorney`. Md. RP § 3-104(f)(1). |
| `txn.binding_authorization` | txn.advance → `offer`, `contract`, `buyer_assigned` | Require an operator with `can_authorize_binding`. Never system-authorized. |
| `content.no_fabrication` | outbound content | Deny if the message references a property fact whose backing fact is `prediction`/`inference` and the template does not hedge it. See §8.3. |
| `spend.caps` | spend.commit | Per §5.1. |

### 8.3 Anti-fabrication

Blueprint §36 forbids representing estimates as verified facts. Implementation: outbound message templates use typed slots. A slot declares its required epistemic level.

```
{{fact:property.address}}              -- requires epistemic = 'fact'
{{estimate:valuation.arv | hedge}}     -- prediction; renderer prefixes hedge language
```

Rendering a `prediction` or `inference` value into a `fact:` slot MUST throw at render time. This makes "we saw your house is worth $210,000" structurally impossible to send.

---

## 9. Provider abstraction

Blueprint §20 and §41.2. All external dependencies sit behind interfaces in `packages/providers`. Every interface has a `Fake` implementation in `packages/testkit` used by all tests.

### 9.1 Data sources

```ts
interface DataSourceAdapter {
  key: string;
  tier: SourceTier;
  scrapingAllowed: boolean;
  costModel: { perCallCents: number; monthlyCents: number };
  fetch(cursor: string | null, signal: AbortSignal): AsyncIterable<RawRecord>;
  normalize(raw: RawRecord): FactDraft[];   // pure, synchronous, unit-tested against golden fixtures
  healthCheck(): Promise<HealthStatus>;
}
```

**MUST:** `normalize` is pure and side-effect-free. Every adapter ships with a committed golden fixture pair (`fixtures/<key>/input.json`, `fixtures/<key>/expected-facts.json`). Upstream schema drift then fails a test rather than silently writing garbage facts.

### 9.2 Contact enrichment

```ts
interface SkipTraceProvider {
  key: string;
  costPerLookupCents: number;
  lookup(input: { person: PersonRef; property: PropertyRef }): Promise<ContactCandidate[]>;
}
interface PhoneValidationProvider {
  validate(e164: string): Promise<{ lineType: LineType; carrier: string; active: boolean; costCents: number }>;
}
```

**MUST:** every lookup writes a `ledger_entries` cost row keyed to the opportunity, whether or not it returned anything. A failed $0.15 lookup is still $0.15.

### 9.3 Communications

```ts
interface CommsProvider {
  channel: CommChannel;
  key: string;
  send(msg: OutboundMessage, grant: ComplianceResult): Promise<Receipt>;  // MUST reject grant.decision !== 'allow'
  estimateCostCents(msg: OutboundMessage): number;
}
interface VoiceAiProvider extends CommsProvider {
  startCall(briefing: SellerBriefing, grant: ComplianceResult): Promise<CallHandle>;
  handleInbound(payload: unknown): Promise<InboundCallResult>;
}
```

V1 implementations: `TwilioSms`, `TwilioVoiceBridge` (connects an operator to the contact; the operator speaks), `LobMail`, `PostmarkEmail`, `BlandVoiceAi` (**inbound + consented callback only**).

**MUST:** `send()` takes the `ComplianceResult` as a required argument and re-validates it. The compliance check cannot be forgotten because the type system will not compile without it.

### 9.4 LLM

```ts
interface LlmProvider {
  complete(req: {
    template: string;            // template key, not raw prompt — enables caching + versioning
    version: string;
    inputs: Record<string, unknown>;
    model: 'haiku' | 'sonnet';
    maxTokens: number;
    schema?: ZodSchema;          // when present, response is structured and validated
  }): Promise<{ output: unknown; costCents: number; cached: boolean }>;
}
```

**MUST:** all prompts live in `packages/core/src/prompts/` as versioned files, never inline. All LLM output entering the fact ledger is written with `epistemic = 'inference'` and the source tier `ai_inference`.

---

## 10. Outreach and conversation

### 10.1 Channel selection

The sequencer picks a channel per touch based on: what's permitted (compliance), what contact data exists, observed per-channel response rate for the cohort, and cost. Given §2.1, the V1 default cold sequence for a Baltimore absentee owner is:

```
Day 0   mail       (letter, no consent required, cheapest per qualified response)
Day 4   voice_human (operator dial from the priority queue — only if rank_score ≥ 60)
Day 9   mail       (second touch, different template)
Day 18  voice_human (final attempt)
Day 19  nurture     (re-touch on new signal only)
```

The sequence is data, not code: `config/sequences/baltimore-absentee-v1.yaml`, assignable per cohort and A/B-testable via `experiments`.

**MUST:** an inbound response of any kind cancels the remaining sequence and creates a bespoke next action. A seller saying "call me tomorrow" produces `next_action(kind='call_seller', due_at=tomorrow 09:00 local, reason='Seller requested callback tomorrow')` — blueprint §15's explicit requirement.

### 10.2 AI voice qualification (inbound)

When a mailer recipient calls the published number:

1. Answer. Disclose: this is an automated assistant (`disclosure.ai_voice`).
2. Request recording consent (`consent.recording`). Record the response as a `consents` row with `evidence_uri` pointing at the audio of the consent exchange itself. If declined → continue unrecorded.
3. Load the `SellerBriefing` for the matched property (matched on inbound caller ID or the campaign code on the mailer).
4. Qualify per the extraction schema (§10.3).
5. Escalate to a human on any of: seller asks a legal question; seller disputes a fact; seller is in foreclosure; seller is elderly/confused or asks to stop; extraction confidence < 0.7; seller names a price.

### 10.3 Briefing and extraction contracts

```ts
interface SellerBriefing {
  property: { address: string; type: string; beds?: number; baths?: number; sqft?: number };
  owner: { displayName: string; isEntity: boolean };
  whyContacting: string;                 // one sentence, from the next action's reason
  verifiedFacts: Array<{ label: string; value: string; source: string }>;  // epistemic='fact' ONLY
  cautions: string[];                    // e.g. "Do not discuss foreclosure status"
  doNotSay: string[];                    // e.g. "Never state an estimated value"
  buyerContext: { matchCount: number };  // count only — never buyer identities
}
```

```ts
const ExtractionSchema = z.object({
  motivation: z.enum(['none','low','medium','high']).nullable(),
  timelineDays: z.number().int().nullable(),
  conditionGrade: z.enum(['turnkey','light','moderate','heavy','teardown']).nullable(),
  occupancy: z.enum(['vacant','owner','tenant','unknown']),
  sellerPriceCents: z.number().int().nullable(),
  reason: z.string().nullable(),
  otherDecisionMaker: z.boolean().nullable(),
  openToOffer: z.boolean().nullable(),
  requestedFollowupAt: z.string().datetime().nullable(),
  doNotContact: z.boolean(),
  confidence: z.number().min(0).max(1),
});
```

**MUST:** `doNotContact = true` immediately writes a `suppressions` row with reason `consumer_revocation`, scope `all`, before any other processing. This path gets its own test.

Extraction results write facts with `epistemic = 'inference'` and trigger a re-score. A seller-stated price becomes a `fact` about *what the seller said* (`seller.stated_price`), not a fact about the property's value.

---

## 11. Transactions

### 11.1 State machine

`qualified → offer → accepted → contract → title → buyer_assigned → closing → paid`, with `terminated` reachable from any state.

Every state declares: required artifacts, required fields, the responsible party, a deadline, and an escalation. Defined in `packages/core/src/transactions/machine.ts` as data.

### 11.2 Deadlines and stall detection

Each state carries a `maxDaysInState` from market config. A worker sweeps hourly; a transaction past its deadline emits `transaction.stalled`, creates a `human_review` next action, and surfaces on the dashboard alert strip. **MUST:** stall detection is independent of any provider callback firing — it runs off the clock and `state_entered_at`, so a dropped webhook cannot silently freeze a deal.

### 11.3 Blocking artifacts

| Target state | Required artifacts | Required fields |
|---|---|---|
| `offer` | — | binding authorization by operator |
| `accepted` | `signed_purchase_agreement` | `contract_price_cents` |
| `contract` | `md_wholesale_disclosure_pre_contract` | binding authorization |
| `title` | `title_order_confirmation` | `title_company` |
| `buyer_assigned` | `md_wholesale_disclosure_pre_assignment`, `signed_assignment_agreement` | `buyer_id`, `assignment_fee_cents` |
| `closing` | — | `closing_attorney` |
| `paid` | `settlement_statement` | `actual_close_date` |

**MUST:** entering `paid` writes the `outcomes` row and the revenue `ledger_entries` row in the same database transaction. Cash and its record are never separable.

---

## 12. Operator dashboard

Next.js, three screens. Blueprint §38 says keep it simple; this spec says *aggressively* simple. Every hour spent on dashboard polish is an hour not spent on the first dollar.

**Screen 1 — Today.** Counts (needs me / calls queued / follow-ups due / near-term projected cash / collected MTD / spent MTD), then the decision queue: open `next_actions` where `requires_human`, ordered by `est_value_cents` desc. Each renders as a decision packet (blueprint §18):

```
DEAL NEEDS YOU
2831 Guilford Ave — Baltimore rowhouse
Why: VBN open 412 days; owner mailing address Boca Raton FL; on 2026 tax sale list ($8,240)
Expected assignment: $3,500–$5,000   ·   P(pay): 34%   ·   Buyer matches: 6
Seller expectation: $120,000 (stated on call 8/9)
Recommended: Make offer at $112,000
[ACCEPT]  [COUNTER]  [REVIEW]  [KILL]
```

Every number is click-through to its provenance. `REVIEW` opens the deal replay.

**Screen 2 — Pipeline.** Stage counts and a filterable list. Read-mostly.

**Screen 3 — Deal.** Facts (grouped by epistemic level with source badges), signal timeline, communications thread, buyer matches, ledger, route comparison table, audit trail.

**Global controls in the header:** `PAUSE OUTBOUND` (kills all channels instantly), plus per-engine toggles. These write `feature_flags` and `audit_log` and take effect within one queue poll (≤ 5s).

---

## 13. Learning

### 13.1 Prediction capture

**MUST:** at the moment an opportunity first enters `contacting`, snapshot the route's predictions into the `outcomes` row's `predicted_*` columns. Capturing predictions *after* the outcome is known is worthless, and it is the single easiest thing to get wrong.

### 13.2 Calibration

Nightly: bucket closed outcomes by predicted `p_pay` in 10 bands, compute actual rates, write `calibration_buckets`. When a bucket has n ≥ 30 and |predicted − actual| > 0.10, emit `calibration.drift` and surface it. **V1 does not auto-tune.** A human reviews and edits the config, and the config version changes. Automatic weight adjustment on 30 samples will chase noise.

### 13.3 Deal replay

`GET /opportunities/:id/replay` reconstructs, purely from the ledger tables: originating source and signals, every score run with its inputs, every action and its reason, every communication and compliance check, the transaction transitions, all costs, and the outcome. **MUST:** replay reads only from persisted rows — it never recomputes a score. If replay can't explain a deal, the instrumentation is incomplete and that's a bug.

### 13.4 V1 metrics

Materialized view refreshed hourly, covering blueprint §39: cost per opportunity, contact rate, conversation rate, motivation rate, offer rate, contract rate, buyer-match rate, close rate, mean/median days to cash, gross revenue, net cash, human minutes per deal, prediction accuracy (Brier score), cost per successful payout, revenue by engine, revenue by source.

**Cost per successful payout is the metric that matters.** Everything else is diagnostic.

---

## 14. Failure, kill switches, safety

Blueprint §34–35.

**Reversible automation ladder.** Every automated action type carries an autonomy level in config: `recommend` → `supervised` → `autonomous`. V1 ships:

| Action | V1 level |
|---|---|
| ingest, normalize, score, rank | autonomous |
| create next action | autonomous |
| send mail | supervised (batch approval) |
| send SMS | supervised |
| operator dial | human by definition |
| AI voice inbound | autonomous, with escalation triggers |
| any transaction transition | human |
| any spend > $5 | supervised |

Promotion from `supervised` to `autonomous` requires 50 consecutive supervised actions with zero operator corrections, recorded in `audit_log`. That's a policy, and it should be enforced by a check in the promotion endpoint.

**Kill switches.** `feature_flags` keys: `outbound.global`, `outbound.<channel>`, `engine.<name>`, `engine.recovery.outreach`, `cohort.<name>`, `stage.T2`, `stage.T3`, `stage.T4`, `source.<key>`, `provider.<key>`. All default **off** for anything that spends money or contacts a human.

**Circuit breakers.** Auto-trip and page: source error rate > 20% over 10 minutes; LLM spend > 3× the 7-day trailing daily mean; outbound volume > 2× the configured daily cap; any provider 5xx rate > 10%; any compliance `deny` rate > 40% (that means a rule or the data is broken).

**Idempotency.** Every worker job is idempotent and keyed. Every outbound message carries an idempotency key = `hash(opportunity_id, template_id, contact_id, scheduled_date)`. A duplicate send is worse than a missed send — it's a TCPA count.

**Retries.** Exponential backoff, max 5, dead-letter queue with alerting. **MUST:** outbound comms are NOT auto-retried on ambiguous failure (a timeout might mean it sent). Ambiguous outbound failures go to human review.

---

## 15. Acceptance tests

Blueprint §44. V1 is complete when all of the following pass in CI against seeded fixtures, plus AT-0 passes once in production with real money.

**AT-0 — The loop (production, once).** A real Baltimore property is discovered from a public source, qualified automatically, contact-researched, contacted, qualified through conversation, routed to a monetization path, matched to a buyer or claimant, moved through the transaction machine, and produces a recorded cash outcome — with a complete replay showing what happened, why, what it cost, and what was earned. Human touches ≤ 5.

**AT-1 — Provenance.** For every fact rendered anywhere in the dashboard, `GET /facts/:id` returns source, timestamp, confidence, and epistemic level. No fact is orphaned.

**AT-2 — Idempotent ingestion.** Running the full Baltimore ingest twice over identical fixtures produces identical property, person, and signal counts, and zero duplicate facts.

**AT-3 — Bootstrap ranking.** The blueprint §14 example: $100/95%/7d/$5 outranks $10,000/30%/90d/$200.

**AT-4 — Compliance blocking.** Each of these MUST be denied and MUST write a `compliance_checks` row: SMS without consent; AI voice cold call; any call at 22:00 local; a fourth touch in one week; any outbound on a `foreclosure.filed` property with the PHIFA flag off; `contract` without the pre-contract disclosure; `buyer_assigned` without the pre-assignment disclosure; `closing` without a closing attorney; any binding transition attempted by the system actor.

**AT-5 — Anti-fabrication.** Rendering a `prediction`-backed value into a `fact:` template slot throws.

**AT-6 — Budget gate.** With a $50 monthly cap and $50 spent, every T3 request is denied and logged. No paid call is made.

**AT-7 — One next action.** Concurrent action-creation for the same opportunity results in exactly one open action (test the race, not just the happy path).

**AT-8 — Kill switch.** With `outbound.global` off, every channel's `send()` rejects within 5 seconds of the flag write.

**AT-9 — Route competition.** An opportunity with wholesale/recovery/land routes activates the highest bootstrap-ranked one and preserves the others; a subsequent signal change can flip the active route, and the flip is audited.

**AT-10 — Replay completeness.** For a seeded closed deal, replay renders every signal, score run, action, communication, compliance check, transition, ledger entry, and the outcome — reading no computed values.

**AT-11 — Revocation.** A `doNotContact` extraction or an inbound STOP writes a suppression before any other processing, and the next send attempt to that contact is denied.

**AT-12 — Stall detection.** A transaction held past `maxDaysInState` produces an alert and a human review action without any provider callback.

---

## 16. Non-goals for V1

Explicitly out of scope (blueprint §40). Do not build these; do not design around building them next month either.

Multi-market management UI · ML scoring models · elaborate dashboards or mobile apps · autonomous negotiation · double-close or transactional funding workflows · accounting integrations · large buyer databases · deep parcel analysis at scale · engines beyond the three named · anything requiring a real estate license.

---

## 17. Open items for the operator (not the developer)

These block *going live*, not building. Track them separately and start now — the legal ones have lead time.

1. Maryland real estate attorney engaged: PHIFA scope, § 10-715 disclosure form, surplus-recovery fee legality and caps, entity structure. **This is the critical path item.**
2. Closing attorney identified who handles investor assignments (Md. RP § 3-104(f)(1)).
3. E&O / general liability posture, and a written TCPA compliance policy.
4. DNC scrubbing vendor selected and registration completed.
5. Skip-trace vendor selected; contract reviewed for permissible-use restrictions.
6. mdlandrec.net and Case Search terms of use reviewed in writing before any automated access.
7. Direct mail vendor and the actual mailer copy, attorney-reviewed.
8. The 10–20 buyer initial cohort assembled by hand (blueprint §12) — this is operator research, not a scraper.
9. Business bank account and a bookkeeping process that the cost ledger reconciles against.
