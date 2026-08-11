# Magnolia

An AI-native real estate opportunity platform for Baltimore. It ingests public property data,
derives distress signals, ranks monetization routes, contacts owners, and tracks deals to a
recorded cash outcome.

Start with [`CLAUDE.md`](./CLAUDE.md) for the invariants, then
[`MAGNOLIA_V1_TECH_SPEC.md`](./MAGNOLIA_V1_TECH_SPEC.md) for the design and
[`BUILD_PLAN.md`](./BUILD_PLAN.md) for the work order.

## Status

**M0 — Repo and rails.** The workspace, strictness settings, enforcement mechanisms, and local
infrastructure. No domain logic yet: package entry points are stubs, and each one names the
BUILD_PLAN milestone that fills it in.

**M1 is blocked.** It requires translating `schema.sql` into a Drizzle schema, and `schema.sql`
has not been supplied.

## Quickstart

Requires Node 22+, pnpm 10+, and Docker.

```bash
pnpm install
cp .env.example .env          # then edit; nothing has a default
pnpm db:up                    # Postgres 16 + PostGIS, Redis
pnpm env:check                # validates .env the same way the apps do at boot
pnpm check                    # lint + typecheck + format + test
```

| Script           | Does                                            |
| ---------------- | ----------------------------------------------- |
| `pnpm check`     | Everything CI runs                              |
| `pnpm test`      | Vitest, once                                    |
| `pnpm lint`      | ESLint, including the vendor-SDK boundary       |
| `pnpm typecheck` | `tsc` across the whole workspace                |
| `pnpm env:check` | Validate the environment without booting an app |
| `pnpm db:up`     | Start Postgres and Redis                        |
| `pnpm db:reset`  | Drop the volumes and re-run the init SQL        |
| `pnpm db:psql`   | psql into the local database                    |

## Layout

```
apps/
  api/              Fastify server, REST + webhooks          (M7, M8)
  worker/           BullMQ processors, schedulers            (M1 onward)
  web/              Next.js operator dashboard               (M8)
packages/
  db/               Drizzle schema, migrations, queries      (M1)
  core/             Fact ledger, signals, scoring, router    (M1-M3)
  providers/        Adapter interfaces + implementations     (M2, M6, M7, M9)
  compliance/       Rule engine + Maryland rule pack         (M4)
  config/           Zod-validated config loaders             (M0 — done)
  testkit/          Fixtures, factories, fake providers      (M1 onward)
config/             Scoring weights, cohorts, sequences — never in code
docker/             Local Postgres init SQL
```

## Two rails worth knowing about before you write code

**The environment refuses to boot rather than guess.** `packages/config` has no `.default()`
anywhere, and a test asserts that structurally. Beyond simple presence, credential _presence
itself_ is environment-dependent: comms credentials are required in production and are a
validation **error** in `local` and `staging`. That implements spec §3.2 — outbound has to be
impossible by construction, not because a flag happened to be set correctly.

**Vendor SDKs are confined by lint.** `eslint.config.mjs` bars comms, LLM, and cloud SDK imports
everywhere except `packages/providers` (comms additionally in `packages/compliance`, per
BUILD_PLAN M0.4). `packages/config/src/__tests__/import-boundary.test.ts` asserts the real
config resolves that way, so a config refactor that drops the rule fails the suite rather than
silently opening the boundary.

## Notes on the toolchain

- Packages resolve each other through `workspace:*` and an `exports` map pointing at `src/`, so
  there is **no build step and no TypeScript project references** yet. One arrives when
  something needs to ship to production.
- `exactOptionalPropertyTypes` is on. In a system where an absent compliance field differs from
  an explicitly-undefined one, that should be a type error.
- The spec documents are excluded from Prettier so they stay diffable against the originals.
