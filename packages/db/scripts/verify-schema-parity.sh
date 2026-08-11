#!/usr/bin/env bash
# Verify the Drizzle migration is semantically identical to schema.sql.
#
# BUILD_PLAN M1.1: "The generated SQL must match schema.sql semantically; note any deliberate
# divergence in the PR." Reading both files side by side does not prove that — Drizzle's output
# differs cosmetically in ways that do not matter (constraint names, literal formatting) and can
# differ substantively in ways that do (null ordering in an index, a dropped DESC). So this
# applies both to throwaway databases and diffs the resulting catalogs.
#
# Every difference it reports is either a real bug or belongs in DIVERGENCES.md.
#
# Usage:  ./scripts/verify-schema-parity.sh
# Requires: docker compose stack up (pnpm db:up).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCHEMA_SQL="$REPO_ROOT/schema.sql"
MIGRATION="$(ls "$REPO_ROOT"/packages/db/migrations/0000_*.sql)"
# Two ways to reach Postgres:
#   direct  — a psql on PATH talking to PGHOST/PGPORT. What CI uses, where Postgres is a
#             service container rather than a compose stack.
#   compose — the default for local development.
# Set PARITY_PSQL_MODE=direct to force the former.
if [ "${PARITY_PSQL_MODE:-compose}" = "direct" ]; then
  export PGHOST="${PGHOST:-localhost}"
  export PGPORT="${PGPORT:-5432}"
  export PGPASSWORD="${PGPASSWORD:-magnolia}"
  PSQL=(psql -U magnolia)
else
  PSQL=(docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres psql -U magnolia)
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail=0

echo "==> Rebuilding reference databases"
"${PSQL[@]}" -d postgres -q \
  -c "DROP DATABASE IF EXISTS ref_sql;" -c "DROP DATABASE IF EXISTS ref_drizzle;" \
  -c "CREATE DATABASE ref_sql;" -c "CREATE DATABASE ref_drizzle;"

"${PSQL[@]}" -d ref_sql -v ON_ERROR_STOP=1 -q < "$SCHEMA_SQL"
sed 's/--> statement-breakpoint//' "$MIGRATION" > "$WORK/mig.sql"
"${PSQL[@]}" -d ref_drizzle -v ON_ERROR_STOP=1 -q < "$WORK/mig.sql" 2>&1 | grep -v NOTICE || true

# ── catalog probes ───────────────────────────────────────────────────────────────────────
cat > "$WORK/tables.sql" <<'SQL'
SELECT tablename FROM pg_tables
WHERE schemaname='public' AND tablename NOT IN ('spatial_ref_sys','__drizzle_migrations');
SQL

cat > "$WORK/columns.sql" <<'SQL'
SELECT table_name||'.'||column_name||' | '||COALESCE(data_type,'')||
       COALESCE('('||character_maximum_length||')','')||
       COALESCE('('||numeric_precision||','||numeric_scale||')','')||' | null='||is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name NOT IN ('spatial_ref_sys','__drizzle_migrations');
SQL

# Index NAMES are dropped: Drizzle auto-names differently and a name is not semantic.
# Everything else — column order, sort direction, null ordering, partial predicate — is kept.
cat > "$WORK/indexes.sql" <<'SQL'
SELECT tablename||' :: '||regexp_replace(
         regexp_replace(indexdef,'^CREATE (UNIQUE )?INDEX [^ ]+ ON','CREATE \1INDEX ON'),
         '\s+',' ','g')
FROM pg_indexes
WHERE schemaname='public' AND tablename NOT IN ('spatial_ref_sys','__drizzle_migrations');
SQL

cat > "$WORK/fks.sql" <<'SQL'
SELECT c.conrelid::regclass::text||' ('||
       (SELECT string_agg(a.attname,',' ORDER BY x.ord) FROM unnest(c.conkey) WITH ORDINALITY x(att,ord)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=x.att)
       ||') -> '||c.confrelid::regclass::text||' ('||
       (SELECT string_agg(a.attname,',' ORDER BY x.ord) FROM unnest(c.confkey) WITH ORDINALITY x(att,ord)
          JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=x.att)
       ||') on_delete='||c.confdeltype::text
FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE c.contype='f' AND n.nspname='public';
SQL

cat > "$WORK/checks.sql" <<'SQL'
SELECT c.conrelid::regclass::text||' :: '||regexp_replace(pg_get_constraintdef(c.oid),'\s+',' ','g')
FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE c.contype='c' AND n.nspname='public' AND t.relname<>'spatial_ref_sys';
SQL

cat > "$WORK/enums.sql" <<'SQL'
SELECT t.typname||' = '||string_agg(e.enumlabel,',' ORDER BY e.enumsortorder)
FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
GROUP BY t.typname;
SQL

# Defaults are compared as the *stored* value, not the literal text: schema.sql writes
# `0.9000` where Drizzle writes `0.9`, and at numeric(5,4) those are the same number.
# trim_scale is what actually normalises them — a plain ::numeric cast preserves scale, so
# `1.0::numeric` stays `1.0` and would still differ from `1`.
cat > "$WORK/defaults.sql" <<'SQL'
SELECT table_name||'.'||column_name||' = '||
       CASE WHEN data_type='numeric' AND column_default ~ '^[0-9.]+$'
            THEN trim_scale(column_default::numeric)::text
            ELSE column_default END
FROM information_schema.columns
WHERE table_schema='public' AND column_default IS NOT NULL
  AND table_name NOT IN ('spatial_ref_sys','__drizzle_migrations');
SQL

# Deliberate divergences, one regex per line. A diff line matching any of these is reported as
# expected rather than failing the run. Every entry here MUST have a section in DIVERGENCES.md.
EXPECTED_DIVERGENCE='^[-+].*facts\.source_id \| uuid \| null=(YES|NO)$'

compare() {
  local label="$1" probe="$2"
  for db in ref_sql ref_drizzle; do
    "${PSQL[@]}" -d "$db" -tA -v ON_ERROR_STOP=1 -f - < "$WORK/$probe" \
      | sed 's/ *$//' | sort > "$WORK/${probe}.$db"
  done
  local n; n=$(wc -l < "$WORK/${probe}.ref_sql")

  if diff -u "$WORK/${probe}.ref_sql" "$WORK/${probe}.ref_drizzle" > "$WORK/${probe}.diff"; then
    printf '  %-12s %4s  identical\n' "$label" "$n"
    return
  fi

  # Drop the diff header, then split real differences from expected ones.
  sed -n '3,$p' "$WORK/${probe}.diff" | grep -E '^[-+]' > "$WORK/${probe}.changed" || true
  grep -Ev "$EXPECTED_DIVERGENCE" "$WORK/${probe}.changed" > "$WORK/${probe}.unexpected" || true
  local expected; expected=$(grep -Ec "$EXPECTED_DIVERGENCE" "$WORK/${probe}.changed" || true)

  if [ -s "$WORK/${probe}.unexpected" ]; then
    printf '  %-12s %4s  DIFFERS\n' "$label" "$n"
    sed 's/^/      /' "$WORK/${probe}.unexpected"
    fail=1
  else
    printf '  %-12s %4s  identical apart from %s expected divergence line(s)\n' \
      "$label" "$n" "$expected"
  fi
}

echo "==> Comparing catalogs"
compare tables   tables.sql
compare columns  columns.sql
compare indexes  indexes.sql
compare fks      fks.sql
compare checks   checks.sql
compare enums    enums.sql
compare defaults defaults.sql

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — the migration matches schema.sql apart from the divergences in DIVERGENCES.md."
else
  echo "FAIL — differences above are either bugs or need an entry in DIVERGENCES.md."
fi
exit "$fail"
