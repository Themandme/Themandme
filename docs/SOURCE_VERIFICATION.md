# Source verification — Baltimore V1

Spec §4.5 marks every data source `[VERIFY]`, and BUILD_PLAN M2's Definition of Done requires
each endpoint be verified **before** its adapter is written. This is that record.

**Verified: 2026-08-11**, `baltimore.tax_sale` added **2026-08-12**. Re-verify before M2 adapters
go live. Endpoints move and datasets go quiet without announcement — this document records the
state on specific days, and an undated "verified" claim is worth very little.

---

## Method, and why it is stated

Recency is established with a **server-side count query** whose result is a bare integer:

```
.../FeatureServer/<layer>/query?where=<DateField>>=timestamp '<date>'&returnCountOnly=true&f=json
→ {"count":387}
```

Not by reading a `max(date)` value and converting it. During this sweep an epoch→ISO conversion
was misread by three months and produced a confident, wrong conclusion that VBN had stalled.
The count query returns a number that means one thing, so it cannot be misread the same way.

Every recency claim below cites the query that produced it. A claim without one is not a
finding.

**Advertised cadence is not evidence.** Open Baltimore describes several datasets as "updated
daily" — including one that has not been updated since 2020. Only measured recency counts.

---

## Verified — current and usable

### `baltimore.vbn` — Vacant Building Notices ✅

- **Endpoint:** `https://egisdata.baltimorecity.gov/egis/rest/services/Housing/DHCD_Open_Baltimore_Datasets/FeatureServer/1`
- **Recency:** `where DateNotice>=timestamp '2026-06-01'` → `{"count":387}`
- **Geometry:** `esriGeometryPoint` · **maxRecordCount:** 1000 · **pagination:** supported
- **Fields:** `NoticeNum`, `DateNotice`, `DateCancel`, `DateAbate`, `NT`, `OWNER_ABBR`,
  `HousingMarketTypology2023`, `Council_District`, `Neighborhood`, `BLOCKLOT`, `Address`

Maps directly onto the design: `DateNotice` drives `vacancy.vbn_opened_at` and the signal's
days-open strength; `DateCancel`/`DateAbate` are exactly the close conditions in spec §4.4;
`BLOCKLOT` populates `properties.blocklot`.

### `baltimore.permits` — Building Permits ✅

- **Endpoint:** same FeatureServer, **layer 3**
- **Recency:** `where IssuedDate>=timestamp '2026-07-01'` → `{"count":3641}`
- **Date fields:** `IssuedDate`, `ExpirationDate`

### `md.sdat_parcel_points` — SDAT parcel points ✅

- **Endpoint:** `https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_PropertyData/MapServer/0`
- **Two corrections to what was seeded:** it is a **MapServer**, not a FeatureServer, and it
  responds on `mdgeodata.md.gov` — the `geodata.md.gov` host returned **HTTP 503** during this
  sweep. Adapters should treat the host as failover-worthy.
- **maxRecordCount:** 2000 live, though the data.gov catalogue advertises 65000. Another case
  of documentation disagreeing with the service.
- **Bulk download:** the state recommends it over querying for this layer, via
  `.../MapServer/exts/MDiMapDataDownload/customLayers/0`. That aligns with spec §4.5's
  preference for bulk download over request-by-request access.
- **Field mapping** — near 1:1 with the predicate registry:

| Predicate                                   | Field                                                              |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `properties.apn` (entity resolution tier 1) | `ACCTID`                                                           |
| `property.year_built`                       | `YEARBLT`                                                          |
| `property.building_sqft`                    | `SQFTSTRC`                                                         |
| `property.last_sale_date`                   | `TRADATE`                                                          |
| `property.last_sale_price_cents`            | `CONSIDR1`                                                         |
| `property.assessed_value_cents`             | `NFMTTLVL` (also `NFMLNDVL`, `NFMIMPVL`)                           |
| `land.use_code`                             | `DESCLU`                                                           |
| `owner.mailing_address`                     | `OWNADD1`, `OWNADD2`, `OWNCITY`, `OWNSTATE`, `OWNERZIP`, `OWNZIP2` |

---

## Verified — dead

### Foreclosure Filings ⚠️ no data since 2020

- **Endpoint:** same FeatureServer, **layer 11**
- **Recency:** `where Date>=timestamp '2021-01-01'` → **`{"count":0}`**
- **Fields:** `BLOCKLOT`, `Date`, `Case__`, `Case_Title`, `Address`, `Zip_Code`, `Comments`,
  plus geocoder artifacts (`Score`, `Match_type`, `Match_addr`, `Addr_type`)

The layer is real and well-shaped — it even carries case numbers — but it stopped being
maintained at the end of 2020. Sibling layers on the same service are current, so this is one
unmaintained dataset, not a portal-wide problem. **Operator action:** raise with Baltimore City
open data; there may be a replacement publication.

**This must not be wired to `foreclosure.filed`.** See the safety note below.

### `baltimore.tax_sale` — Tax Sale ⚠️ located, frozen at FY2021

**Located** — the previous pass recorded this as "not found", which was wrong. It is not on the
DHCD FeatureServer with the other Baltimore layers; it is its own service under the Department
of Finance folder, which is why a search of the DHCD service missed it.

- **Endpoint:** `https://egisdata.baltimorecity.gov/egis/rest/services/DOF/TaxSale/MapServer`
- **Type:** MapServer (like SDAT, unlike the DHCD layers) · **maxRecordCount:** 1000
- **Capabilities:** `Map,Query,Data`

| Layer | Name                          | `where=1=1&returnCountOnly=true` |
| ----- | ----------------------------- | -------------------------------- |
| 0     | `FY2021_TaxSale_LiensRemoved` | `{"count":933}`                  |
| 1     | `FY2021_TaxSale`              | `{"count":9485}`                 |
| 2     | `FY18_20_TaxParticipation`    | `{"count":28147}`                |

- **Fields (identical on all three):** `BLOCK`, `LOT`, `BLOCKLOT`, `ADDRESS`, `ZipCode`,
  `NEIGHBORHOOD`, `OWNER`, `TaxSale_Year`

#### Why it is not usable, despite responding

1. **There is no date field.** `TaxSale_Year` is the only candidate and it is `null` on every
   record sampled across all three layers. The service's own description names its contents as
   "FY2018-2020 … FY2021" — the recency is in the _layer names_, not in the data.
2. **The recency probe cannot be run at all.** Every other entry in this document cites a
   `where <DateField> >= timestamp '…'` count query. There is no date field to filter on, so
   that method does not apply here. This entry rests on the layer names and the service
   description instead, and that weaker basis is stated rather than papered over.
3. **The newest data is FY2021 — five years stale.**

`tax.on_sale_list` (signal weight 0.22, second heaviest) is a **current-state** signal: it
asserts that a property _is_ on the tax sale list. A FY2021 snapshot cannot answer that in 2026,
and recording it would assert a stale fact as current in a signal that drives outreach.

`tax.delinquent_balance_cents` has **no source here at all** — there is no balance, amount or
lien-value field in the schema.

**Do not write the adapter for either predicate.** Baltimore's tax sale is an annual auction and
the current-year list is published by the Bureau of Revenue Collections as a document rather than
as a queryable layer, which is a fit for the M2.6 manual-upload path, not for an ArcGIS adapter.
An ArcGIS Hub search surfaced no current Baltimore tax-sale service; the newest related item is a
2021 list.

#### One useful finding

**`OWNER` is populated on 100% of rows** (`where OWNER IS NOT NULL` → `{"count":9485}` against a
total of 9485). This is the first Baltimore source seen to carry owner names, and it bears on two
things currently documented as blocked: spec §4.3's owner-name confirming attribute for entity
resolution, and person resolution generally. It does **not** unblock them — a 2021 owner name is
exactly the kind of stale personal data that must not drive outreach — but it does mean the
obstacle is this dataset's age, not the absence of the field city-wide.

---

## Structure confirmed, recency not yet measured

All on the same `DHCD_Open_Baltimore_Datasets` FeatureServer. **The Baltimore "sources" in
§4.5 are largely layers on one service, not separate endpoints** — one client, many
normalizers.

| Layer | Name                             | Note                                            |
| ----- | -------------------------------- | ----------------------------------------------- |
| 0     | Completed City Demo              | `DateUpdate`, `DateStarted`, `DateDemoFinished` |
| 2     | Rehabs of Vacant Buildings       | `DateIssue`                                     |
| 4     | Receivership - Filed and Open    | `DateFiled`, `ReceiverAppointed`, `DateAuction` |
| 5     | Receivership - Settled           | `SoldAtAuction`, `Settlement_DateSaleRatified`  |
| 7     | Open Bid List - Vacants to Value | no date fields                                  |
| 9     | Open Work Orders                 | `DateCreate`, `DateFinish`                      |
| 12    | Real Property                    | no date fields                                  |

**Layers 4 and 5 fill a gap in the spec.** §4.4 defines a `code.receivership` signal, but
§4.5's source table names nothing that supplies it. These layers do.

---

## Not yet verified

Nothing below has been confirmed. Do not write an adapter against any of it first.

- **`baltimore.code_violations`** — not located this pass. Feeds `code.violation_open_count`.
  Now the highest-priority remaining gap, since `tax_sale` resolved to "found but frozen" above.
  Worth searching the per-department folders (`DOF`, `Housing`, `311`, `Transportation`,
  `Utilities`, `CityView`) rather than only the DHCD service — that is how `tax_sale` was missed.
- **`baltimore.311`** — datasets exist but are **partitioned by calendar year**
  (`311 Customer Service Requests 2019` … `2026`), which an adapter must handle and roll over
  annually. A consolidated `Customer_Service_Request311_2021_Present` layer appeared in search
  results but **404'd** when fetched.
- **`baltimore.open_bid`** (layer 7), **`baltimore.real_property`** (layer 12) — structure seen,
  no recency measured; neither exposes a date field, so recency needs a different probe.
- **`md.parcel_boundaries`**, **`md.sdat_entities`** — not checked.

### Host sprawl

Four hostnames appeared for Baltimore City data during this sweep:
`egisdata.baltimorecity.gov`, `gis.baltimorecity.gov`, `opendata.baltimorecity.gov`,
`egis.baltimorecity.gov`. Which are canonical versus legacy is unresolved. Adapters should
pin the verified host per source rather than assume a shared base.

---

## Out of scope — counsel, not code

`md.land_records` (mdlandrec.net) and `md.case_search` (Maryland Judiciary Case Search) were
**not** investigated, deliberately. Both restrict automated extraction, and spec §4.5 requires
they stay `scraping_allowed: false` / `access_method: manual_upload` until the terms are
reviewed **in writing** (§17.6).

Nothing in this document clears any source for automated access. Verifying that an endpoint
_works_ says nothing about whether we are permitted to call it.

---

## Safety note — the foreclosure gap

The compliance rule `phifa.gate` (spec §8.2) denies outbound when the `foreclosure.filed`
signal is **active**. With no working foreclosure source, that signal will be inactive for
every filing since 2020 — so **absence of the signal is not evidence of no foreclosure**.

This loosens nothing. `cohort.pre_foreclosure` stays off, and outreach still requires written
attorney sign-off recorded in `audit_log` (§2.3). What it means is that `phifa.gate` is a
backstop rather than a guarantee, and **M4 must not treat a passing gate as proof the property
is not in foreclosure.** Until a live foreclosure source exists, the protection is the disabled
cohort flag, not the rule.

---

## Design consequence — freshness monitoring

A dataset that stops updating still returns HTTP 200 with a well-formed, empty delta.
`sources.last_success_at` updates, the §14 circuit breakers (error rate, 5xx rate) stay quiet,
and the source looks healthy while producing nothing. That is precisely the Foreclosure
Filings failure, and nothing in the current design would have caught it.

**Two of the sixteen seeded sources have now failed this way** — Foreclosure Filings (silent
since 2020) and Tax Sale (frozen at FY2021). Both feed high-weight signals. That is no longer a
one-off worth noting; it is the most common failure mode observed in this codebase so far.

**Tax Sale is the harder variant.** Foreclosure Filings at least has a date field, so
`max(facts.observed_at)` would eventually reveal the silence. Tax Sale has **no date field at
all**, so a freshness check computed from facts cannot distinguish "frozen since 2021" from
"correct and unchanging" — every fetch returns the same 9,485 rows, forever, and every one of
them would look freshly observed.

**Proposed, to be wired in M2**, in two parts:

1. **Freshness from facts** — compare `max(facts.observed_at)` per source against that source's
   expected cadence and alert past a multiple of it. No schema change; computes from facts
   already recorded. Catches the Foreclosure Filings shape.
2. **Payload-stability check** — flag a source whose every fetch banks zero new `raw_records`
   for longer than its cadence. `raw_records_dedupe` already makes this observable: `banked=0`
   across consecutive runs is exactly the signal, and `IngestReport.banked` already reports it.
   Catches the Tax Sale shape, where the data has no date to be stale by.

Neither replaces verification. A source with no date field cannot have its recency measured from
the outside at all, which is why the entry above rests on layer names and says so.
