#!/bin/bash
#
# SessionStart hook — bring up the datastores Magnolia's tests actually require.
#
# Why this exists: the remote container has no systemd, so `systemctl enable postgresql` is
# accepted and then never fires. A container restart therefore leaves Postgres and Redis dead
# with the data directory intact, and every database-backed test fails — and those suites FAIL
# rather than skip (packages/testkit/src/db.ts), because a skipped test and a passing one look
# identical in a summary.
#
# Everything here is idempotent: it is safe on a fresh container, on a restarted one where the
# data survived, and on a session resumed minutes later.
set -euo pipefail

# Local machines have their own Postgres and Redis; do not touch them.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

DB_URL="postgres://magnolia:magnolia@localhost:5432/magnolia"
REDIS_URL="redis://localhost:6379"

# Persist for the session so commands do not each have to export it.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export DATABASE_URL=\"${DB_URL}\""
    echo "export REDIS_URL=\"${REDIS_URL}\""
  } >> "$CLAUDE_ENV_FILE"
fi

log() { echo "[session-start] $*"; }

# ── Packages ────────────────────────────────────────────────────────────────────────────
# PostGIS is not optional: properties.centroid and parcels.geom are geometry columns, and the
# migration's hand-written CREATE EXTENSION prelude fails without it.
if [ ! -d /usr/lib/postgresql/16 ] || ! ls /usr/share/postgresql/16/extension/postgis.control >/dev/null 2>&1; then
  log "installing postgresql-16 + postgis + redis"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    postgresql-16 postgresql-16-postgis-3 redis-server >/dev/null
fi

# ── Postgres ────────────────────────────────────────────────────────────────────────────
if ! pg_isready -h 127.0.0.1 -q 2>/dev/null; then
  log "starting postgres"
  # A container killed mid-write leaves a stale pid file; pg_ctlcluster removes it and recovers.
  sudo pg_ctlcluster 16 main start 2>&1 | sed 's/^/[session-start] /' || true
fi

for _ in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -q 2>/dev/null && break
  sleep 1
done
if ! pg_isready -h 127.0.0.1 -q 2>/dev/null; then
  log "ERROR: postgres did not become ready"
  exit 1
fi

# Role and database. `|| true` on the create: losing a race with a concurrent run is fine,
# a genuinely broken cluster is caught by the extension step below.
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='magnolia'" | grep -q 1; then
  log "creating role magnolia"
  sudo -u postgres psql -qc "CREATE ROLE magnolia LOGIN SUPERUSER PASSWORD 'magnolia'" >/dev/null || true
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='magnolia'" | grep -q 1; then
  log "creating database magnolia"
  sudo -u postgres psql -qc "CREATE DATABASE magnolia OWNER magnolia" >/dev/null || true
fi

# drizzle-kit does not emit CREATE EXTENSION, so migration 0000 carries them — but the scratch
# databases the test harness creates need them too. Installing here covers both.
# client_min_messages=warning: `IF NOT EXISTS` emits a NOTICE on every rerun, and a hook that
# prints three lines of noise on the happy path trains people to stop reading its output.
PGPASSWORD=magnolia psql -h 127.0.0.1 -U magnolia -d magnolia -qc \
  "SET client_min_messages = warning;
   CREATE EXTENSION IF NOT EXISTS postgis;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null 2>&1

# ── Redis ───────────────────────────────────────────────────────────────────────────────
# BullMQ backs the ingest scheduler and the outbox publisher. --save '' keeps it in memory:
# nothing here is durable state, and RDB snapshots of a throwaway queue are just IO.
if ! redis-cli ping >/dev/null 2>&1; then
  log "starting redis"
  redis-server --daemonize yes --port 6379 --save '' --appendonly no >/dev/null
  for _ in $(seq 1 15); do
    redis-cli ping >/dev/null 2>&1 && break
    sleep 1
  done
fi
redis-cli ping >/dev/null 2>&1 || { log "ERROR: redis did not become ready"; exit 1; }

# ── Workspace ───────────────────────────────────────────────────────────────────────────
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

log "installing dependencies"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null

log "applying migrations"
DATABASE_URL="$DB_URL" pnpm --filter @magnolia/db migrate >/dev/null 2>&1 || {
  log "ERROR: migrations failed"
  DATABASE_URL="$DB_URL" pnpm --filter @magnolia/db migrate 2>&1 | tail -20
  exit 1
}

# Seed is idempotent by design (invariant 7) and asserts its own invariants — notably that no
# feature flag ships enabled. Running it every session keeps config drift from accumulating.
log "seeding"
DATABASE_URL="$DB_URL" pnpm --filter @magnolia/db seed 2>&1 | tail -3 | sed 's/^/[session-start] /'

log "ready — postgres, redis, migrations and seed all up"
