import {
  asNumber,
  asString,
  dollarsToCents,
  epochToDate,
  layerCount,
  queryAll,
  type ArcGisLayer,
} from '../arcgis/client.js';
import type {
  DataSourceAdapter,
  HealthStatus,
  NormalizedFact,
  PropertyRef,
  RawRecord,
} from '../types.js';

/**
 * `baltimore.permits` — Building Permits.
 *
 * Verified 2026-08-11: layer 3 of the shared DHCD FeatureServer,
 * `IssuedDate>=timestamp '2026-07-01'` → `{"count":3641}`.
 *
 * ## This source emits MANY records per property, and that changes things
 *
 * VBN and SDAT emit roughly one record per property, so "the current fact from this source" is
 * unambiguous for them. A property can have dozens of permits going back decades, and the
 * service pages them in its own order.
 *
 * The three predicates here all describe *the most recent* permit, which is only well defined
 * because `recordFact` supersedes on **observation time**: each record is normalized with
 * `observedAt = IssuedDate`, so the newest permit wins whatever order the pages arrive in. That
 * guard was added for this adapter — before it, ingesting a 2019 permit after a 2026 one left
 * 2019 standing as current, and the read model reported a seven-year-old rehab as the latest.
 * The same applies to `code_violations` and `311` when those are written.
 *
 * ## The predicates are new
 *
 * Spec §4.5 lists this source "(rehab activity, builder identification)" but §4.4 defines no
 * permit signal and §4.1 no permit predicate — the source had nowhere to land. `permit.*` were
 * added to `config/predicates/v1.yaml`; the derived SIGNAL is M3 work and is deliberately not
 * invented here. See packages/db/DIVERGENCES.md.
 */

export const PERMIT_FIELDS = [
  'CaseNumber',
  'Description',
  'IssuedDate',
  'ExpirationDate',
  'Address',
  'BLOCKLOT',
  'ExistingUse',
  'ProposedUse',
  'Neighborhood',
  'Cost',
  'Council_District',
  'IsPermitModification',
  'PermitName',
].join(',');

/** Permit descriptions run long and carry CRLF from the intake form. */
const MAX_DESCRIPTION = 2000;

function propertyRef(
  attributes: Record<string, unknown>,
  centroid: [number, number] | null,
): PropertyRef {
  return {
    apn: null,
    blocklot: asString(attributes['BLOCKLOT']),
    addressLine1: asString(attributes['Address']) ?? '',
    addressLine2: null,
    city: 'BALTIMORE',
    stateCode: 'MD',
    /* The layer carries no ZIP, same as VBN. */
    postalCode: null,
    centroid,
    ownerName: null,
  };
}

/**
 * Collapse the intake form's whitespace and clip to the predicate's schema bound.
 *
 * Descriptions arrive with CRLF runs and instructions to the applicant embedded in them
 * ("PLEASE AMEND THIS PERMIT APPLICATION TO ADD YOUR LICENSED GC."), so this is normalization,
 * not interpretation — the text is stored as filed, just made comparable.
 */
function cleanDescription(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.length > MAX_DESCRIPTION ? collapsed.slice(0, MAX_DESCRIPTION) : collapsed;
}

/** Pure. No I/O, no clock. Spec §9.1 MUST. */
export function normalizeBuildingPermit(raw: RawRecord): NormalizedFact[] {
  const attributes = raw.payload;
  const centroidValue = attributes['__centroid'];
  const centroid =
    Array.isArray(centroidValue) && centroidValue.length === 2
      ? ([Number(centroidValue[0]), Number(centroidValue[1])] as [number, number])
      : null;

  const subject = propertyRef(attributes, centroid);
  if (subject.addressLine1 === '' && subject.blocklot === null) return [];

  /*
   * An unissued permit is an application, not activity. Without a date there is also nothing to
   * order the supersede by, so such a record would overwrite whichever permit happened to be
   * current — exactly the bug the observation-time guard exists to prevent. Drop it.
   */
  const issued = epochToDate(attributes['IssuedDate']);
  if (issued === null) return [];

  const facts: NormalizedFact[] = [
    {
      subject,
      predicate: 'permit.last_issued_at',
      value: issued.toISOString().slice(0, 10),
      epistemic: 'fact',
      observedAt: issued,
      confidence: 0.95,
    },
  ];

  /* `Cost` is the applicant's declared job cost in whole dollars. Zero is a real and common
     value (no-fee permits), so it is recorded rather than treated as missing — only an absent
     or unparseable figure is skipped. */
  const cost = asNumber(attributes['Cost']);
  if (cost !== null) {
    const cents = dollarsToCents(cost);
    if (cents !== null) {
      facts.push({
        subject,
        predicate: 'permit.last_cost_cents',
        value: cents,
        epistemic: 'fact',
        observedAt: issued,
        confidence: 0.9,
      });
    }
  }

  const description = cleanDescription(attributes['Description']);
  if (description !== null) {
    facts.push({
      subject,
      predicate: 'permit.last_description',
      value: description,
      epistemic: 'fact',
      observedAt: issued,
      confidence: 0.95,
    });
  }

  return facts;
}

export interface PermitsAdapterOptions {
  userAgent: string;
  baseUrl?: string;
  pageSize?: number;
}

export function createBaltimorePermitsAdapter(options: PermitsAdapterOptions): DataSourceAdapter {
  const layer: ArcGisLayer = {
    url:
      options.baseUrl ??
      'https://egisdata.baltimorecity.gov/egis/rest/services/Housing/DHCD_Open_Baltimore_Datasets/FeatureServer/3',
    /* Service reports maxRecordCount 1000. */
    pageSize: options.pageSize ?? 1000,
    userAgent: options.userAgent,
  };

  return {
    key: 'baltimore.permits',
    tier: 'official_record',
    scrapingAllowed: true,
    costModel: { perCallCents: 0, monthlyCents: 0 },

    async *fetch(_cursor, signal) {
      /* Oldest-first, so an interrupted run leaves a prefix of history rather than an arbitrary
         slice. `OBJECTID` is appended because `IssuedDate` alone is not unique — dozens of
         permits share an issue date, and offset pagination over a non-total order lets the
         service reorder tied rows between pages, duplicating some and dropping others. The
         observation-time supersede makes correctness independent of arrival order anyway; this
         just keeps the walk itself total. */
      for await (const { attributes, centroid } of queryAll(
        layer,
        {
          where: 'IssuedDate IS NOT NULL',
          outFields: PERMIT_FIELDS,
          orderByFields: 'IssuedDate,OBJECTID',
        },
        signal,
      )) {
        yield {
          sourceKey: 'baltimore.permits',
          sourceRecordId: asString(attributes['CaseNumber']),
          payload: { ...attributes, __centroid: centroid },
          observedAt: epochToDate(attributes['IssuedDate']) ?? new Date(),
        };
      }
    },

    normalize: normalizeBuildingPermit,

    async healthCheck(): Promise<HealthStatus> {
      const controller = new AbortController();
      try {
        /* Liveness, not reachability. Three of sixteen seeded sources have gone quiet while
           still answering 200 (docs/SOURCE_VERIFICATION.md), so a plain ping proves nothing. */
        const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
        const count = await layerCount(
          layer,
          `IssuedDate>=timestamp '${since} 00:00:00'`,
          controller.signal,
        );
        return {
          ok: count > 0,
          detail:
            count > 0
              ? `${String(count)} permits issued in the last 90 days`
              : `no permits since ${since} — source may have stalled`,
          checkedAt: new Date(),
        };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: new Date(),
        };
      }
    },
  };
}
