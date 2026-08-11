# Divergences from `schema.sql`

`schema.sql` is the database review artifact and the source of truth. BUILD_PLAN M1.1 requires
that the generated migration match it semantically, and that any deliberate divergence be
noted. This file is that note.

`./scripts/verify-schema-parity.sh` applies both to throwaway databases and diffs the resulting
catalogs — tables, columns, types, nullability, defaults, indexes, foreign keys, check
constraints, and enum labels. Anything listed here is allowlisted in that script; anything not
listed fails the run.

Current state:

```
tables         45  identical
columns       554  identical apart from 2 expected divergence line(s)
indexes       105  identical
fks            70  identical
checks          2  identical
enums          19  identical
defaults      113  identical
```

---

## 1. `facts.source_id` is `NOT NULL`

**schema.sql (line 350):** `source_id uuid REFERENCES sources(id)` — nullable.
**Here:** `NOT NULL`.

### Why

Three separate places in the specification say a fact without provenance is invalid:

- `CLAUDE.md` invariant 2 — "Every fact has a source, a timestamp, a confidence, and an
  epistemic level… There is no default source."
- Spec §4.1 rule 2 (MUST) — "every fact carries `source_id`, `observed_at`, and `confidence`.
  There is no default source. A fact with no provenance is a bug."
- Spec §15 AT-1 — for _every_ fact rendered anywhere, `GET /facts/:id` returns source,
  timestamp, confidence, and epistemic level. "No fact is orphaned."

A nullable column makes the bug representable, and AT-1 cannot be guaranteed against a schema
that permits the orphan. The sibling columns `observed_at` and `confidence` are already
`NOT NULL` in schema.sql, which suggests `source_id` was meant to be and was missed.

### Why nothing legitimately needs the NULL

The `source_tier` enum already covers every producer of a fact, including Magnolia's own:
`derived` for computed facts, `ai_inference` for LLM output, `human` for operator entry. Each
gets a row in `sources`, so there is always something to point at. The seed creates these
internal source rows for exactly this reason.

### Reversibility

This is the conservative direction. Relaxing it later is one line:

```sql
ALTER TABLE facts ALTER COLUMN source_id DROP NOT NULL;
```

Tightening it after facts exist is not — it requires backfilling provenance that was never
captured, which is the situation the invariant exists to prevent.

**If this reading is wrong, say so and it comes out.** It is flagged here rather than applied
silently precisely because it is a judgement call about the artifact rather than a translation
detail.

---

## Not divergences, but worth knowing

**Constraint and index names.** Drizzle auto-names constraints
(`transaction_transitions_compliance_check_id_compliance_checks_i`, truncated at Postgres's
63-character identifier limit) where schema.sql sometimes names them explicitly. Names are not
semantic, so the parity script strips index names before comparing and compares foreign keys by
their column relationships rather than their names.

**Numeric default formatting.** schema.sql writes `0.9000` and `1.0`; Drizzle emits `0.9` and
`1`. At `numeric(5,4)` these are the same stored value — verified, not assumed. The parity
script normalises with `trim_scale()`, since a plain `::numeric` cast preserves scale and would
report a false difference.

**Extensions.** drizzle-kit does not emit `CREATE EXTENSION`, so the three from the top of
schema.sql (`postgis`, `pg_trgm`, `pgcrypto`) are prepended to migration `0000` by hand. Without
them the geometry columns and the trigram GIN indexes fail outright. Keep this in mind when
regenerating: **re-running `drizzle-kit generate` from scratch drops the prelude.**

**PostGIS column types.** Drizzle's built-in `geometry()` hardcodes `geometry(point)` — it drops
the SRID and cannot express MultiPolygon. `properties.centroid` and `parcels.geom` therefore use
custom types in `src/schema/column-types.ts` that emit `geometry(Point,4326)` and
`geometry(MultiPolygon,4326)` exactly.

**The `communications` outbound trigger is not built yet.** schema.sql line 594 comments that
the `compliance_check_id IS NOT NULL` invariant is "enforced in app + trigger" but ships no
trigger body. BUILD_PLAN M4.4 assigns building it, and nothing writes to `communications` before
M7, so the ordering holds. This is a deferral, not a divergence — but it is the one place where
a stated invariant currently has no database-level enforcement, so it is recorded here too.
