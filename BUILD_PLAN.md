# Magnolia V1 — Build Plan

Ordered work packages. Each is sized to be one Claude Code session with a green test suite at the end. **Do not start a package until the prior one's Definition of Done is met** — the ordering exists because later packages depend on invariants earlier ones establish.

Legend: `AT-n` = acceptance test from the spec §15 that this package unlocks.

---

## M0 — Repo and rails (½ day)

1. pnpm workspace: `apps/{api,worker,web}`, `packages/{db,core,providers,compliance,config,testkit}`.
2. TypeScript strict everywhere. `noUncheckedIndexedAccess: true`. No `any` — CI fails on it.
3. docker-compose: Postgres 16 + PostGIS, Redis.
4. Vitest, ESLint (with the `no-restricted-imports` rule barring comms providers outside `packages/compliance` and `packages/providers`), Prettier, GitHub Actions running lint + typecheck + test on every push.
5. `.env.example` with every variable. Zod-validated config loader that throws at boot on a missing var — never a silent default.

**DoD:** `pnpm test` green on an empty suite; `docker compose up` gives a working DB.

---

## M1 — Schema and fact ledger (1–2 days)

1. Translate `schema.sql` into Drizzle schema + initial migration. The generated SQL must match `schema.sql` semantically; note any deliberate divergence in the PR.
2. Seed: Baltimore market row, source rows, predicate registry, feature flags (all spend/contact flags **off**), spend caps.
3. `packages/core/src/facts/`: `recordFact`, `currentFacts`, `supersede`, `detectConflicts`, `resolveConflict`.
4. Predicate validation: writing an unregistered predicate, or a value failing the predicate's JSON Schema, throws.
5. Read-model projector: recompute `properties`/`parcels` scalar columns from current facts. Idempotent, re-runnable.
6. Transactional outbox: `emitEvent` writes to `events` inside the caller's DB transaction; a publisher worker moves them to BullMQ.

**DoD:** AT-1 passes. Property-based test: any sequence of fact writes leaves the read model equal to a from-scratch recomputation.

---

## M2 — Baltimore ingestion (3–4 days)

1. `DataSourceAdapter` interface + registry + BullMQ scheduler driven by `sources.refresh_cron`.
2. Adapters, in this order (each with committed golden fixtures and a pure `normalize`):
   `md.sdat_parcel_points` → `md.parcel_boundaries` → `baltimore.vbn` → `baltimore.tax_sale` → `baltimore.code_violations` → `baltimore.permits` → `baltimore.311` → `baltimore.open_bid`.
3. Entity resolution per spec §4.3, with the duplicate-review path.
4. Address normalization (USPS-style) as a pure, heavily-tested function. Baltimore rowhouse addresses have unit suffixes and half-numbers; write the tests first.
5. Parcel adjacency precompute (PostGIS `ST_Touches`), materialized and refreshed on boundary change.
6. `manual_upload` path for sources where automated access isn't permitted: CSV upload → raw record → same normalizer, provenance tier `human`.

**DoD:** AT-2 passes. Full Baltimore load completes with a per-source record count report and zero unresolved schema errors. Verify each endpoint against §4.5 **before** writing the adapter — endpoints move.

---

## M3 — Signals and scoring (2–3 days)

1. Signal registry (spec §4.4) as pure functions `facts → SignalState`. One test file per signal.
2. Signal engine: event-driven on `fact.recorded`, plus a nightly full sweep as a safety net. Opens/closes signals, emits `signal.opened` / `signal.closed`.
3. Opportunity creation: cohort rules from `config/cohorts/baltimore-v1.yaml` create opportunities from signal combinations. `pre_foreclosure_equity` ships with `enabled: false`.
4. Scoring engine per spec §6, config-driven, writing `score_runs` on every run.
5. Router: route creation per engine, activation, preservation, audited switching.
6. Lifecycle worker: aging/stale/recycle transitions.

**DoD:** AT-3 and AT-9 pass. Scoring the full Baltimore dataset costs $0 and finishes in under 10 minutes.

---

## M4 — Compliance engine (2 days) — **before any comms code**

1. Rule engine: pure rule functions, ordered evaluation, full `RuleResult[]` capture, `policy_version` stamping.
2. The Maryland rule pack (spec §8.2). Every rule gets a citation comment and its own test file.
3. `suppressions` and `consents` services, including the fast revocation path.
4. DB trigger enforcing `communications.compliance_check_id IS NOT NULL` on outbound rows.
5. Template renderer with typed epistemic slots (spec §8.3).

**DoD:** AT-4 and AT-5 pass. Every rule has a test proving both the allow and the deny path.

---

## M5 — Cost gate and ledger (1 day)

1. `requestStage` per spec §5.1, throwing on denial, writing audit rows.
2. `ledger_entries` service; every provider call site posts a cost row, including on failure.
3. Spend counters with atomic increment; caps enforced inside the same transaction as the spend commit.
4. Circuit breakers (spec §14).

**DoD:** AT-6 passes. A test proves a failed paid lookup still posts its cost.

---

## M6 — Contact enrichment (1–2 days)

1. `SkipTraceProvider` and `PhoneValidationProvider` interfaces + fakes; one real implementation each.
2. Contact confidence model: source tier, corroboration count, line type, recency, prior bad-contact history.
3. Enrichment orchestration gated on `scoring.gate.skiptrace_min_rank`, skipping persons with a usable existing contact.

**DoD:** Enriching an opportunity below the rank gate is denied and logged. No lookup is ever made twice for the same person within the cache TTL.

---

## M7 — Communications (2–3 days)

1. `CommsProvider` interface; `LobMail` and `TwilioSms` implementations; `TwilioVoiceBridge` for operator dialing.
2. Sequencer: YAML-driven, event-cancellable, timezone-aware, idempotency-keyed.
3. Inbound webhook handlers: SMS reply, STOP keyword, mail response codes, missed/returned calls.
4. `PAUSE OUTBOUND` and per-channel kill switches wired end to end.

**DoD:** AT-8 and AT-11 pass. In `staging`, provider implementations are absent from the container and the sequencer degrades to logging intended sends.

---

## M8 — Next-action engine and dashboard (3 days)

1. Next-action engine: derives the single open action from opportunity state, route, sequence position, and compliance. Enforces the one-open-action invariant under concurrency.
2. Next.js dashboard: Today / Pipeline / Deal. Decision packets with click-through provenance.
3. Auth (session cookie, `operators` table), roles, `can_authorize_binding`.
4. Global and per-engine kill-switch controls in the header.

**DoD:** AT-7 passes. An operator can go from login to an accept/counter/kill decision in under 30 seconds.

---

## M9 — AI voice, inbound only (2 days)

1. `VoiceAiProvider` + Bland implementation, **inbound and consented-callback only**.
2. Opening script: AI disclosure, then recording consent, with the consent exchange itself archived.
3. `SellerBriefing` builder — `epistemic = 'fact'` values only, plus `doNotSay` guardrails.
4. Extraction to the zod schema; low-confidence and escalation-trigger paths to human review.
5. Extraction → facts → re-score → new next action.

**DoD:** A simulated inbound call produces a validated extraction, a re-score, and a next action. A simulated "take me off your list" produces a suppression before anything else runs.

---

## M10 — Buyer intelligence (2 days)

1. Buyer tables + manual entry UI for the 10–20 seed cohort.
2. `buyer_purchases` ingestion from deed/sales data; observed-profile recompute on change.
3. Matching: comparable-purchase similarity (price band, geography, type, size), scored with evidence. Observed behavior weighted far above stated criteria.
4. Buyer response capture feeding `buyer_matches.response` and buyer reliability.

**DoD:** For a seeded opportunity, matches return with the specific comparable purchases that justify each score.

---

## M11 — Transactions (2 days)

1. State machine as data; transitions with artifact gates and binding authorization.
2. Artifact upload and verification.
3. Stall detection worker (clock-driven, not callback-driven).
4. `paid` writes outcome + revenue ledger in one DB transaction.

**DoD:** AT-4 (transaction rules) and AT-12 pass.

---

## M12 — Learning (1–2 days)

1. Prediction snapshot at `contacting`.
2. Calibration job and drift alerts. No auto-tuning.
3. Deal replay endpoint + UI, reading only persisted rows.
4. Metrics materialized view (spec §13.4).

**DoD:** AT-10 passes.

---

## M13 — Recovery and land engines (2–3 days)

1. Recovery: identification and verification stages only. Outreach behind `engine.recovery.outreach`, default off.
2. Land: cheap SQL screen, then deep analysis only for survivors with a builder match.
3. Builder matching reusing M10.

**DoD:** Both engines produce scored, ranked, displayable routes. Neither can contact anyone with its flag off.

---

## M14 — Production hardening and AT-0

1. Deploy, backups (daily + PITR), restore drill actually performed.
2. Sentry, structured logs, `/health`, uptime check.
3. Runbook: how to pause outbound, how to roll back, who to call.
4. Live sources verified; comms providers configured; spend caps set conservatively (suggest $200/month global to start).
5. Run AT-0 for real.

**DoD:** One Baltimore opportunity produces recorded cash with a complete replay.

---

## Estimate

Roughly 25–35 working days for one competent full-stack developer working with Claude Code, assuming the operator items in spec §17 progress in parallel. **The legal engagement is the critical path** — M7 onward cannot go live without it, even though it can all be built.
