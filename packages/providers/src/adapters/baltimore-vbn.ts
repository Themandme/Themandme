import { asString, epochToDate, layerCount, queryAll, type ArcGisLayer } from '../arcgis/client.js';
import type {
  DataSourceAdapter,
  HealthStatus,
  NormalizedFact,
  PropertyRef,
  RawRecord,
} from '../types.js';

/**
 * `baltimore.vbn` — Vacant Building Notices.
 *
 * Verified 2026-08-11: layer 1 of the shared DHCD FeatureServer, 387 notices since 2026-06-01.
 *
 * Unlike SDAT, this layer DOES use epoch milliseconds for its dates, so it uses the shared
 * `epochToDate`. The two sources disagreeing on date encoding is why each adapter owns its own
 * parsing rather than inheriting one.
 *
 * The signal this feeds (spec §4.4 `vacancy.vbn_open`) opens while a notice is outstanding and
 * closes when it is cancelled or abated — which is exactly `DateCancel` / `DateAbate`. So the
 * adapter emits `vacancy.vbn_open: false` when either is set rather than emitting nothing:
 * a closed notice has to actively retract the signal, and omitting the fact would leave the
 * last `true` standing as current forever.
 */

export const VBN_FIELDS = [
  'NoticeNum',
  'DateNotice',
  'DateCancel',
  'DateAbate',
  'NT',
  'Neighborhood',
  'Council_District',
  'BLOCKLOT',
  'Address',
].join(',');

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
    /* The layer carries no ZIP. Resolution falls back to APN/blocklot and fuzzy address plus a
       confirming attribute; address_hash without a ZIP still hashes deterministically. */
    postalCode: null,
    centroid,
    ownerName: null,
  };
}

/** Pure. No I/O, no clock. Spec §9.1 MUST. */
export function normalizeVacantBuildingNotice(raw: RawRecord): NormalizedFact[] {
  const attributes = raw.payload;
  const centroidValue = attributes['__centroid'];
  const centroid =
    Array.isArray(centroidValue) && centroidValue.length === 2
      ? ([Number(centroidValue[0]), Number(centroidValue[1])] as [number, number])
      : null;

  const subject = propertyRef(attributes, centroid);
  if (subject.addressLine1 === '' && subject.blocklot === null) return [];

  const noticeDate = epochToDate(attributes['DateNotice']);
  const cancelled = epochToDate(attributes['DateCancel']);
  const abated = epochToDate(attributes['DateAbate']);
  const isOpen = cancelled === null && abated === null;

  /* Prefer the notice's own date as the observation time — when the notice was issued is when
     the vacancy was observed. Fall back to the record's fetch time. */
  const observedAt = noticeDate ?? raw.observedAt;

  const facts: NormalizedFact[] = [
    {
      subject,
      predicate: 'vacancy.vbn_open',
      value: isOpen,
      epistemic: 'fact',
      observedAt,
      confidence: 0.95,
    },
  ];

  if (noticeDate !== null) {
    facts.push({
      subject,
      predicate: 'vacancy.vbn_opened_at',
      value: noticeDate.toISOString().slice(0, 10),
      epistemic: 'fact',
      observedAt,
      confidence: 0.95,
    });
  }

  return facts;
}

export interface VbnAdapterOptions {
  userAgent: string;
  baseUrl?: string;
  pageSize?: number;
}

export function createBaltimoreVbnAdapter(options: VbnAdapterOptions): DataSourceAdapter {
  const layer: ArcGisLayer = {
    url:
      options.baseUrl ??
      'https://egisdata.baltimorecity.gov/egis/rest/services/Housing/DHCD_Open_Baltimore_Datasets/FeatureServer/1',
    /* Service reports maxRecordCount 1000. */
    pageSize: options.pageSize ?? 1000,
    userAgent: options.userAgent,
  };

  return {
    key: 'baltimore.vbn',
    tier: 'official_record',
    scrapingAllowed: true,
    costModel: { perCallCents: 0, monthlyCents: 0 },

    async *fetch(_cursor, signal) {
      for await (const { attributes, centroid } of queryAll(
        layer,
        { where: '1=1', outFields: VBN_FIELDS },
        signal,
      )) {
        yield {
          sourceKey: 'baltimore.vbn',
          sourceRecordId: asString(attributes['NoticeNum']),
          payload: { ...attributes, __centroid: centroid },
          observedAt: epochToDate(attributes['DateNotice']) ?? new Date(),
        };
      }
    },

    normalize: normalizeVacantBuildingNotice,

    async healthCheck(): Promise<HealthStatus> {
      const controller = new AbortController();
      try {
        /* Liveness, not just reachability: a count of notices in the last 90 days. A source
           that answers 200 with nothing new is the failure mode that killed the foreclosure
           layer, and a plain ping would call it healthy. */
        const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
        const count = await layerCount(
          layer,
          `DateNotice>=timestamp '${since} 00:00:00'`,
          controller.signal,
        );
        return {
          ok: count > 0,
          detail:
            count > 0
              ? `${String(count)} notices in the last 90 days`
              : `no notices since ${since} — source may have stalled`,
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
