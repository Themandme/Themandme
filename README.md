# Magnolia

An AI-native real estate opportunity platform for Baltimore. It ingests public property data,
derives distress signals, ranks monetization routes, contacts owners, and tracks deals to a
recorded cash outcome.

Start with [`CLAUDE.md`](./CLAUDE.md) for the invariants, then
[`MAGNOLIA_V1_TECH_SPEC.md`](./MAGNOLIA_V1_TECH_SPEC.md) for the design and
[`BUILD_PLAN.md`](./BUILD_PLAN.md) for the work order.

## Status

**M0–M2, with gaps that are documented rather than hidden.**

- **M0** — workspace, strictness, enforcement, local infrastructure. Done.
- **M1** — Drizzle schema (parity-checked against `schema.sql`), seed, predicate registry, fact
  ledger, read-model projector, conflict resolution, transactional outbox. Done.
- **M2** — address normalization, entity resolution, adapter interface and registry, ingestion
  pipeline, cron scheduler, queue consumer, manual-upload CSV path. AT-2 passes. **Three of
  eight adapters are written**, because the other five are blocked on sources that do not
  verify.

The blocker worth knowing about: **three of sixteen seeded sources are confirmed dead while
still answering HTTP 200** — Foreclosure Filings (silent since 2020), Tax Sale (frozen at
FY2021), Receivership (stopped 2021). Each feeds a signal §4.4 defines, so this is the largest
open risk to M3's signal coverage, and it is a data problem rather than a code one.
`docs/SOURCE_VERIFICATION.md` records what was measured, how, and on what date.

Deliberate deviations from the spec live in `packages/db/DIVERGENCES.md`, each with the
measurement that prompted it.

## Quickstart

Requires Node 22+, pnpm 10+, and Docker — or native Postgres and Redis, see below.

```bash
pnpm install
cp .env.example .env          # then edit; nothing has a default
pnpm db:up                    # Postgres 16 + PostGIS, Redis
pnpm env:check                # validates .env the same way the apps do at boot
pnpm check                    # lint + typecheck + format + test
```

| Script                | Does                                            |
| --------------------- | ----------------------------------------------- |
| `pnpm check`          | Everything CI runs                              |
| `pnpm test`           | Vitest, once                                    |
| `pnpm lint`           | ESLint, including the vendor-SDK boundary       |
| `pnpm typecheck`      | `tsc` across the whole workspace                |
| `pnpm env:check`      | Validate the environment without booting an app |
| `pnpm db:up`          | Start Postgres and Redis                        |
| `pnpm db:reset`       | Drop the volumes and re-run the init SQL        |
| `pnpm db:psql`        | psql into the local database                    |
| `pnpm signals:census` | Fire rates for every signal over loaded data    |

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

## Running it

```bash
pnpm dev:worker     # scheduler + ingest consumer + outbox publisher
pnpm dev:api        # Fastify, /health and /ready

pnpm stack:up       # or: everything in containers, app profile
pnpm stack:logs
```

**Booting enables nothing.** Every external source seeds `enabled: false` with its kill switch
off (invariant 8), so a fresh worker sweeps, finds everything refused, logs the reason per
source, and fetches nothing. That is the intended day-one state. To actually run a source you
must turn on both the `sources` row and its `source.<key>` feature flag — two deliberate acts.

### Operational endpoints

| Endpoint  | Checks                 | Use for                                             |
| --------- | ---------------------- | --------------------------------------------------- |
| `/health` | nothing — process only | liveness probe, container healthcheck               |
| `/ready`  | Postgres + Redis       | load-balancer readiness; 503 when a dependency down |

Keep these distinct. Pointing a **liveness** probe at `/ready` means a brief Postgres blip marks
every replica unhealthy, the orchestrator restarts them all at once, and they stampede a database
that is already struggling. `/ready` returning 503 pulls one replica out of rotation and lets it
rejoin by itself — verified: with Redis stopped, `/health` stays 200 while `/ready` returns 503
in under 3 ms naming the failed dependency, and recovers with no restart.

### Signals

Both processes shut down gracefully on SIGTERM — the worker stops the scheduler first, drains
in-flight ingest jobs, then closes the pool.

**Do not wrap them in `npx`.** `npx` does not forward SIGTERM: signalling it kills the wrapper
and leaves the Node process orphaned, still holding queue locks. Observed directly while testing
this. The image uses tini as an init and exec-form CMD so the signal reaches the real process.

Both `dev` and `start` run under **`tsx`**, not `node --experimental-strip-types`. The workspace
uses NodeNext `.js` import specifiers that resolve to `.ts` files — required by `tsc` — and
Node's native type stripping does not rewrite that specifier, so it fails with
`ERR_MODULE_NOT_FOUND` on the first relative import. `tsc` still runs in CI as the typechecker.

### Resuming a partial load

```bash
pnpm ingest:resume md.sdat_parcel_points
```

Runs phase two alone — normalize whatever is banked but not yet normalized — without re-fetching.
`ingestSource` always fetches first, which for SDAT is eight minutes of paging a state endpoint
to re-learn what is already in `raw_records`.

It retries with backoff and a fresh connection pool per attempt, because over the tens of minutes
a full-market load takes, a database restart is a normal event rather than an exceptional one —
that happened three times during the SDAT load here, and each time the committed work survived
and only the process died. The retry is safe because the pipeline is idempotent (invariant 7):
an already-normalized record is not in the pending set. It stops if a pass makes no progress,
since that is a failure retrying will not fix.

### Re-deriving facts after a normalizer fix

```bash
pnpm ingest:renormalize md.sdat_parcel_points   # clears normalized_at
pnpm ingest:resume      md.sdat_parcel_points   # re-derives, no re-fetch
```

`ingest:resume` finishes work that was never done. This handles the other case: work that _was_
done, by a normalizer that has since been fixed. Those records are marked complete, so `resume`
correctly skips them and the fix stays inert against everything already loaded.

Only `normalized_at` is cleared. Raw records are untouched and **facts are never deleted** — the
ledger is append-only, so a corrected value arrives by superseding the old one and the old fact
stays readable for replay.

### What the signals actually do

```bash
pnpm signals:census
```

Evaluates the whole signal registry over every loaded property and reports fire rate, mean and
median strength per signal, plus the fact count behind each predicate. Read-only.

The unit tests prove each rule is _correct_. They cannot tell you whether it is _useful_, and
those are different failures with the same symptom. A signal firing on 90% of the market
separates nothing; one firing on 0% is either a wrong rule or — far more often here — a dead
source. **Those two look identical from a fire rate alone**, which is why the census prints
predicate coverage beside it: a signal reading a predicate with zero facts is untested by this
data, not disproven by it. Reading `vacancy.vbn_open: 0.00%` and concluding Baltimore has no
vacant buildings would be exactly backwards.

Run it after each new source lands; the diff in fire rates is what that source bought. It is
also how the leading-zero house-number bug below was found.

### Repairing the read model

```bash
pnpm reproject
```

Recomputes `properties` scalar columns from current facts for every property — BUILD_PLAN M1.5's
repair path, made runnable. Always safe and always idempotent, because the read model is a pure
function of current facts.

Needed less often now that `normalizePending` projects per chunk rather than once at the end, but
still the right tool when a projection is suspected wrong. **217,463 properties in 43 seconds.**

### Measured throughput

A full live `baltimore.vbn` load, 2026-08-12:

```
fetched 11,536 · banked 11,536 · normalized 11,536
facts 23,034 · properties 11,513 · errors 0
fetch 53s · total 340s
```

The fetch was not the slow part — normalization and projection were the other ~290s. Both costs
are now fixed:

- **Resolution** ran once per _fact_ rather than once per _subject_, so every record paid the
  tier-1/2/3 cascade twice (8× for SDAT). Memoised per record.
- **Projection** cost one query per projectable column plus an UPDATE — about twelve round trips
  per property, so 11,513 properties meant ~138,000 queries. `projectProperties` batches to two
  queries per 500 properties.

Measured on the same 11,513 properties:

| Path         | Per property | 11,513    | SDAT 222,703 (extrapolated) |
| ------------ | ------------ | --------- | --------------------------- |
| per-property | 9.90 ms      | ~114 s    | ~37 min                     |
| batched      | 0.174 ms     | **2.0 s** | **~39 s**                   |

A full-market SDAT load is now a routine operation rather than an overnight one.

`projectProperty` is kept, not replaced: it is the readable definition of what projection means
and the property test's reference implementation. Because the batched path reimplements winner
selection, and the projector is the only writer of the read model (invariant 1), the two are
tested against each other directly — a silent disagreement between them would mean a property
projected in a batch gets a different value from the same property projected alone.

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
