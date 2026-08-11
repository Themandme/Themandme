# CLAUDE.md — Magnolia

Read `MAGNOLIA_V1_TECH_SPEC.md` before writing code. `schema.sql` is the database review artifact. `BUILD_PLAN.md` gives the work order — follow it; the ordering encodes dependencies.

## What this is

An AI-native real estate opportunity platform for Baltimore. It ingests public property data, derives distress signals, ranks monetization routes, contacts owners, and tracks deals to a recorded cash outcome. Capital-light, cash-flow-focused, automation-first.

## Non-negotiable invariants

Break any of these and the build is wrong, regardless of whether tests pass.

1. **Nothing writes to `facts` except normalizers.** Ingestors write `raw_records`. Property/person scalar columns are a read model recomputed from facts, never written directly.
2. **Every fact has a source, a timestamp, a confidence, and an epistemic level** (`fact` / `prediction` / `inference`). LLM output is always `inference`. There is no default source.
3. **No outbound communication without a `ComplianceResult` with `decision === 'allow'`.** `send()` takes the grant as a required argument and re-validates it. `communications.compliance_check_id` is NOT NULL on outbound, enforced by a DB trigger.
4. **Exactly one open `next_actions` row per live opportunity.** Enforced by a partial unique index. Creating a new one closes the old one with an outcome.
5. **No paid stage (T2/T3/T4) without a granted `requestStage` call.** The gate throws; it never returns an ignorable false.
6. **Binding transaction transitions require a human operator with `can_authorize_binding`.** The system actor may never authorize one.
7. **Idempotency everywhere.** Re-running ingestion creates nothing new. Every outbound message carries an idempotency key. A duplicate send is a legal liability, not a cosmetic bug.
8. **Kill switches default to off** for anything that spends money or contacts a person.

## Legal constraints baked into the design

Do not "optimize" these away. Each is in the spec §2 with reasoning.

- **AI voice is inbound-only** (or consented callback). Cold AI voice calls violate the TCPA as interpreted by the FCC's Feb 2024 declaratory ruling. Cold outbound is direct mail and operator-dialed voice.
- **Maryland is an all-party recording-consent state.** Consent is captured on the call and archived.
- **Pre-foreclosure outreach is gated** behind a feature flag and attorney sign-off (Maryland PHIFA).
- **Maryland wholesaler disclosures and attorney-close are blocking transaction artifacts**, not reminders.
- **Recovery-engine outreach is flag-gated** pending a legal answer on finder's fees.

If a task seems to require violating one of these, stop and say so rather than working around it.

## Stack

TypeScript 5 / Node 22 · pnpm monorepo · Postgres 16 + PostGIS · Drizzle · BullMQ + Redis · Fastify + zod · Next.js 15 + Tailwind · Anthropic API behind `LlmProvider`.

## Code conventions

- `strict: true`, `noUncheckedIndexedAccess: true`, no `any`. CI fails on violations.
- Money is integer cents. Probabilities are `numeric(5,4)` in [0,1]. Timestamps are `timestamptz` in UTC.
- Adapters' `normalize()` functions are pure and synchronous, tested against committed golden fixtures.
- Prompts live in `packages/core/src/prompts/` as versioned files. Never inline a prompt.
- Scoring weights, sequences, cohorts, and market parameters live in `config/`, never in code.
- All external dependencies sit behind an interface in `packages/providers` with a `Fake` in `packages/testkit`.
- No package outside `packages/providers` imports a vendor SDK. ESLint enforces this.

## Testing

Write the test first for: address normalization, every compliance rule (allow _and_ deny paths), every signal function, the bootstrap ranking example, and every idempotency claim.

The acceptance tests in spec §15 are the definition of done. Run them in CI.

## When you hit an unknown

Anything marked **[VERIFY]** in the spec is a fact about the outside world — an endpoint, a statute, a vendor term. Do not guess it and do not let a guess reach production. Surface it, stub it behind an interface, and flag it for the operator.

Escalate rather than assume. That applies to the code as much as it does to the system it describes.
