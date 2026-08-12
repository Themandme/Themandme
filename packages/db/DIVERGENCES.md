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
columns       557  identical apart from 2 expected divergence line(s)
indexes       106  identical
fks            70  identical
checks          2  identical
enums          19  identical
defaults      114  identical
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

## Change made to `schema.sql` itself

Not a divergence — both sides carry it — but it is an edit to the review artifact, so it is
recorded here.

### `facts_one_current_per_source`

```sql
CREATE UNIQUE INDEX facts_one_current_per_source
  ON facts (subject_type, subject_id, predicate, source_id) WHERE is_current;
```

Spec §4.1 rule 5 already intends at most one _current_ fact per subject+predicate+source —
superseding clears `is_current` on the old row. Nothing enforced it, so the invariant lived
entirely in application discipline: a bug in `recordFact`, a concurrent write, or a future
caller bypassing supersede would each silently produce two "current" facts from one source,
which then reads as a conflict that rule 6 was never meant to describe (rule 6 is about
disagreement _between_ sources).

It does not suppress conflict detection: two current facts from _different_ sources remain
possible, which is exactly what the resolver handles. A test asserts both halves —
that the database rejects a second current fact from one source, and that it permits two from
different sources.

Building against it surfaced a real ordering constraint, now documented in `recordFact`:
superseding needs three statements, not two. The unique index requires the old row to stop
being current _before_ the insert, while `facts_superseded_by_facts_id_fk` requires the new row
to exist _before_ the old row can point at it. Clear, insert, then link — inside a transaction.

### `predicates` resolution/projection policy columns

```sql
read_model_column text,
tolerance         numeric,
conflict_escalate boolean NOT NULL DEFAULT false
```

These three came from `config/predicates/v1.yaml` and could have been read from the file at
runtime. They are persisted instead because spec §13.3 requires deal replay to read **only**
from persisted rows: a tolerance that decided a conflict, or an escalation flag that sent one
to a human, has to be recoverable as it was _then_, not as the YAML happens to read later.

This follows the path `sources` already uses — config is authored in `config/`, the seed writes
it to the database, and services read the database. The file remains the place you edit.

---

### `normalize()` returns `NormalizedFact[]`, not `FactDraft[]`

Spec §9.1 declares `normalize(raw: RawRecord): FactDraft[]` and, in the same paragraph, requires
that `normalize` be **pure and side-effect-free**. Those cannot both hold: `FactDraft` carries a
`subjectId`, a property UUID that only exists after a database lookup.

So `normalize` returns `NormalizedFact[]`, which names its subject by natural key
(`PropertyRef`: apn, blocklot, address, centroid, owner name) rather than by id. The ingestion
pipeline resolves that reference to a property and then calls `recordFact` with a real
`subjectId`.

Purity is the half worth keeping. It is what makes the golden-fixture requirement in the same
section work at all — the fixture test runs `normalize` with no database, so upstream schema
drift fails a test instead of silently writing garbage facts.

---

### Tier-3 entity resolution does not use similarity as the match decision

Spec §4.3 defines tier 3 as trigram similarity `>= 0.92` on the address plus a confirming
attribute (a parcel centroid within 50 m, or a matching owner name), with the score as the thing
that decides and the centroid as a secondary check.

Implemented instead: **the match decision is structural, and the score is demoted to a candidate
recall prefilter.** `packages/core/src/resolution/resolve-property.ts`.

#### Why — measured, not assumed

Every number below was measured on 2026-08-11: distances from live SDAT parcel points on
Guilford Ave, scores from `pg_trgm` `similarity()` in Postgres 16.

**Neither mechanism can separate house numbers.**

| Pair                             | Distance  |
| -------------------------------- | --------- |
| 2832 → 2834 (adjacent rowhouses) | **4.4 m** |
| 2834 → 2836                      | 5.2 m     |
| Across the street                | ~70 m     |
| Ends of a 12-parcel block        | ~60 m     |

A 50 m radius spans about ten neighbouring houses, so it cannot distinguish 2832 from 2834.
Those same neighbours score **0.800** on the full address — just under the spec's threshold, in
the region where the radius has just been shown to be useless. The two checks fail on the _same_
pair, so neither backstops the other, and any downward tuning of the threshold merges neighbours.

**Similarity cannot separate street names either.** The two distributions overlap completely:

| Must MATCH                     |           | Must REJECT             |           |
| ------------------------------ | --------- | ----------------------- | --------- |
| `GUILFORD` / `GUILFORDD`       | 0.727     | `LOMBARD` / `LOMBARDY`  | **0.700** |
| `PENNSYLVANIA` / `PENNSYLVANA` | 0.667     | `LIGHT` / `LIGHTS`      | 0.625     |
| `GUILFORD` / `GUILFRD` (typo)  | **0.545** | `FAYETTE` / `LAFAYETTE` | 0.500     |
| `BALTIMORE` / `BALTIMOR`       | 0.727     | `PARK` / `PARKWAY`      | 0.444     |
| `SAINT PAUL` / `ST PAUL`       | **0.462** | `CALVERT` / `CALHOUN`   | 0.231     |

There is no threshold that admits the typo at 0.545 while rejecting `LOMBARD`/`LOMBARDY` at
0.700. Worse, **`N CHARLES ST` vs `S CHARLES ST` scores 0.786** — above every genuine typo in the
set — and Baltimore numbers north and south from Baltimore St, so 100 N Charles and 100 S Charles
both exist and are different buildings.

#### What replaced it

Each mechanism is used only where it actually discriminates:

| Component                    | Rule                                          | Why that mechanism                                                                                                                   |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| House number, fraction, unit | **Exactly equal**                             | Structural. Neither score nor distance can do it.                                                                                    |
| Directional, suffix          | **Equal or absent on one side**               | Absence is missing data; a difference is a different street. Catches the N/S case a score waves through.                             |
| Street name                  | **Centroid within the market radius**         | Useless at 5 m, decisive at street scale — different streets are hundreds of metres apart. Rejects `LOMBARD`/`LOMBARDY` on geometry. |
| —                            | Trigram similarity: **recall prefilter only** | Chooses which rows to examine, never which rows match.                                                                               |

A merge now requires the house number, fraction and unit to be identical, the directional and
suffix to be compatible, **and** the centroids to agree. No text score at any threshold can
produce one on its own, which is a strictly stronger reading of the spec's own
"never auto-merge on fuzzy alone" than the 0.92 rule delivered.

The two thresholds live in `config/markets/baltimore.yaml` with **no code-level fallback**
(CLAUDE.md: market parameters live in `config/`, never in code); `loadResolutionParams` throws
if a market lacks them rather than resolving at a compiled-in value.

#### Consequences to know about

- **`fuzzy_address_threshold` is now a recall floor, not a safety parameter.** It is set to 0.30.
  Lowering it costs extra rows to examine and cannot cause a merge. Raising it above ~0.5 starts
  _losing_ legitimate typo matches. The name is kept because it is already in the seeded config;
  the YAML comment states what it actually governs.
- **`SAINT PAUL` / `ST PAUL` (0.462) is handled by the recall floor, not fixed properly.** The
  right fix is a `SAINT → ST` entry in the normalizer's abbreviation table, so the two strings
  never differ in the first place. Left as-is deliberately rather than tuning a threshold down to
  0.45, which would be indiscriminate.
- **The owner-name confirmer from §4.3 is still not implemented**, because no _usable_ source
  supplies an owner name — SDAT parcel points has no owner-name field (all 114 checked) and VBN
  has none. Baltimore's tax-sale service does carry one on every row, but its data is frozen at
  FY2021, and a five-year-old owner name is not a confirming attribute. Not stubbed: an
  unreachable branch cannot be tested.
- Verified by mutation, not just by a green suite — neutering the structural gate fails exactly
  the five merge-safety tests it is responsible for, and leaves the centroid-guarded case
  passing.

---

### `recordFact` supersedes on observation time, not arrival time

Spec §4.1 rule 5 says the newest fact from a source supersedes the older one. As implemented,
"newest" meant _most recently written_ — `recordFact` compared the incoming draft only against
whatever was currently flagged, and superseded unconditionally.

**Here:** a draft whose `observed_at` is strictly older than the current fact's is dropped.

#### Why

The two readings agree for a source that emits roughly one record per property, which is why
this survived M1 and M2 slice 1 — `baltimore.vbn` emits one notice per property and
`md.sdat_parcel_points` one row per parcel.

They diverge as soon as a source emits **many** records per property, in the order the service
happens to page them. `baltimore.permits` does: a property can carry dozens of permits going
back decades. Under the old rule, ingesting a 2019 permit after a 2026 one left the 2019 date
standing as the property's current permit fact, and the read model then reported a seven-year-old
rehab as the latest activity. `baltimore.code_violations` and `baltimore.311` have the same
shape and would inherit the same bug.

The fix is what makes predicates like `permit.last_issued_at` well defined at all — "last" is
otherwise a statement about page order.

#### The boundary is strictly-older, deliberately

Equal timestamps still supersede. A source restating the same instant with a different value is
issuing a **correction**, and the later statement should win; treating equality as "drop" would
make corrections unlandable. Both halves are asserted in `fact-ledger.test.ts`.

An older observation is dropped rather than raised as an error: it is not wrong, it is simply
not current, and the newer fact it would have replaced is already recorded and already correct.
History is not lost either — the older row is absent only from `is_current`, and a source that
genuinely needs backfilled history recorded can write it before the newer fact arrives.

---

### `permit.*` predicates added; the permit SIGNAL deliberately not

Spec §4.5 lists `baltimore.permits` as a V1 source, annotated "(rehab activity, builder
identification)". But **§4.4's signal registry defines no permit signal, and §4.1's predicate
list names no permit predicate.** The source had nowhere to land: `facts.predicate` is a foreign
key, so an adapter would have produced facts the database rejects.

Added to `config/predicates/v1.yaml`: `permit.last_issued_at`, `permit.last_cost_cents`,
`permit.last_description`.

The **signal** is not added. §4.4 signals are derived from facts by pure functions in
`packages/core/src/signals`, which is M3 work, and inventing the open/close rule and strength
input now — before any permit facts exist to look at — would be guessing at exactly the kind of
thing this project measures instead. Recording the facts in M2 is what lets M3 write that
function against real data.

This is the mirror image of the `code.receivership` gap: there, §4.4 defines a signal that §4.5
supplies no source for (and the source that appeared to fill it turned out to be dead — see
`docs/SOURCE_VERIFICATION.md`). Here, §4.5 supplies a source that §4.4 defines no signal for.
Both suggest §4.4 and §4.5 were written independently and never reconciled.

---

### ArcGIS `queryAll` sorts by `OBJECTID` unless told otherwise

Not a spec divergence — a correctness fix with no spec text either way, recorded because it is
invisible until it corrupts a load.

`queryAll` pages with `resultOffset`. An offset walk over an **unordered** result set is
undefined: the service may return rows in a different order per request, which silently
duplicates some records across pages and drops others. The bug does not throw, and its symptom
is a record count that is quietly wrong.

`ArcGisQuery` now takes `orderByFields`, defaulting to `OBJECTID` — present and unique on every
ArcGIS layer, which is exactly what offset pagination needs. Callers supplying their own must
keep it **total**: `baltimore.permits` orders by `IssuedDate,OBJECTID` rather than `IssuedDate`
alone, because dozens of permits share an issue date and ties would reorder between pages.

---

### Manual upload has two provenance modes, not one

BUILD_PLAN M2.6 specifies the manual-upload path as "CSV upload → raw record → same normalizer,
provenance tier `human`". Spec §4.5 says the same of ToS-restricted sources: reachable "only by
manual operator lookup recorded as a human-tier fact".

**Here:** the caller must choose `provenance: 'operator' | 'transcribed'`, and there is no
default.

#### Why one mode is not enough

§4.2 ranks `human` as the **highest** authority — literally `human: 0` in
`packages/core/src/facts/conflicts.ts`, above `official_record`. A fact recorded against
`magnolia.human` therefore beats every automated source, permanently.

That is exactly right for what §4.5 describes: an operator opens Case Search, reads one docket,
and records what they saw. A person who looked at the thing should outrank a feed.

It is badly wrong for the other case the same path invites. Baltimore's live tax-sale list is an
annual **document**, so loading it means transcribing thousands of rows. At tier `human`, every
one of those rows would outrank SDAT forever, and a single transcription typo could never be
corrected by any automated source — the correction would itself have to be manual, in
perpetuity. One mistyped house number becomes permanent.

So:

| Mode          | Facts recorded against           | §4.2 authority                 | For                                        |
| ------------- | -------------------------------- | ------------------------------ | ------------------------------------------ |
| `operator`    | `magnolia.human`                 | highest — overrides everything | §4.5 manual lookup; operator corrections   |
| `transcribed` | the originating source's own row | that source's tier             | bulk transcription of a published document |

`transcribed` also multiplies each fact's confidence by `TRANSCRIPTION_CONFIDENCE_FACTOR` (0.9).
The tier still asserts "this is an official record", which is true; the confidence says we are
slightly less sure it was copied correctly, which is also true. Transcription is lossy in a way
an API response is not.

There is **no default** because choosing wrong is silent and the damage surfaces much later —
the same reason `resolveProperty` takes its thresholds as required options.

The originating dataset stays recoverable in both modes: it is written to `source_fetches`
`storage_uri` alongside the operator and origin, and into every payload under a namespaced
`__upload` envelope. Without that, a `magnolia.human` fact could not tell §13.3 replay which
document the operator was reading.

#### `scraping_allowed` is deliberately NOT required here

This looks like a hole and is the opposite. §4.5 keeps `md.case_search` and `md.land_records`
non-scrapable **and**, in the same sentence, says they are reachable by manual operator lookup.
Requiring `scraping_allowed` on this path would forbid the one route the spec permits.

The gate is an operator instead: `uploadedBy` is mandatory and non-blank, so every fact arriving
this way names the person who supplied it. Automated access remains refused by
`registry.requireRunnable` and by the scheduler; both have tests asserting these two sources can
never be fetched or enqueued.

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
