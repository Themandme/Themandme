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

Requires Node 22+, pnpm 10+, and Docker — or native Postgres and Redis, see below.

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

### Without Docker

`pnpm db:up` needs a working Docker daemon, and some sandboxed environments cannot run one. The
specific failure to recognise: `/etc/init.d/docker` raises the hard file-descriptor limit on
`start`, which requires `CAP_SYS_RESOURCE`. Where that capability is dropped the script aborts
**before `dockerd` is ever exec'd**, so a stale `/var/run/docker.sock` remains and `docker ps`
reports "Cannot connect to the Docker daemon" — which reads like a crashed daemon rather than
one that never launched. Confirm with `pgrep dockerd` (nothing) and
`grep CapBnd /proc/self/status` (bit 24 clear).

Nothing in the stack actually needs Docker; it is packaging convenience. Both services run
natively:

```bash
# Postgres 16 + PostGIS 3.4
sudo apt-get install -y postgresql-16 postgresql-16-postgis-3
sudo pg_ctlcluster 16 main start
sudo -u postgres psql -c "CREATE ROLE magnolia LOGIN SUPERUSER PASSWORD 'magnolia'"
sudo -u postgres psql -c "CREATE DATABASE magnolia OWNER magnolia"
psql "$DATABASE_URL" -c "CREATE EXTENSION postgis; CREATE EXTENSION pg_trgm; CREATE EXTENSION pgcrypto"

# Redis
redis-server --daemonize yes --port 6379

pnpm --filter @magnolia/db migrate
pnpm --filter @magnolia/db seed
```

The three extensions are not optional: `postgis` for `properties.centroid` and `parcels.geom`,
`pg_trgm` for the entity-resolution recall prefilter, `pgcrypto` for the schema's defaults.
drizzle-kit does not emit `CREATE EXTENSION`, so migration `0000` carries them in a hand-written
prelude — see `packages/db/DIVERGENCES.md` before regenerating migrations.

The database- and Redis-backed suites **fail** rather than skip when a service is unreachable. A
skipped test and a passing one look identical in a CI summary, and those suites are the only
thing checking the fact-ledger invariants and that a ToS-restricted source cannot be enqueued.

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
