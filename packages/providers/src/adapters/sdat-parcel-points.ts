import { normalizeAddress } from '@magnolia/core';
import {
  asNumber,
  asString,
  dollarsToCents,
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
 * `md.sdat_parcel_points` — SDAT parcel ownership, valuation and structure.
 *
 * Verified 2026-08-11 (docs/SOURCE_VERIFICATION.md). MapServer layer 0 on `mdgeodata.md.gov`;
 * the `geodata.md.gov` host returned 503. Monthly refresh from SDAT.
 *
 * Two things the captured fixture established that documentation did not:
 *
 *   - `TRADATE` is a **YYYYMMDD string** (`"19950725"`), not epoch milliseconds. The shared
 *     `epochToDate` helper would silently return null for it. Baltimore's ArcGIS layers DO use
 *     epoch ms, so date handling is per-source, not shared.
 *   - `YEARBLT` is a string too (`"1914"`).
 *
 * And one gap: **SDAT parcel points carries no owner NAME field** — all 114 fields were
 * checked. It has the owner's mailing address only. Person resolution (spec §4.3) matches on
 * normalized name plus a shared address, so persons cannot be created from this source. That
 * needs `baltimore.real_property` or `md.land_records`, and is flagged in
 * SOURCE_VERIFICATION.md.
 */

const BALTIMORE_CITY = 'BACI';

export const SDAT_FIELDS = [
  'ACCTID',
  'YEARBLT',
  'SQFTSTRC',
  'TRADATE',
  'CONSIDR1',
  'NFMTTLVL',
  'DESCLU',
  'OWNADD1',
  'OWNADD2',
  'OWNCITY',
  'OWNSTATE',
  'OWNERZIP',
  'ADDRESS',
  'CITY',
  'ZIPCODE',
  'JURSCODE',
  'BLOCK',
  'LOT',
  'STRTNUM',
  'STRTDIR',
  'STRTNAM',
  'STRTTYP',
  'STRTUNT',
].join(',');

/** `YYYYMMDD` -> ISO date string, or null. Rejects impossible dates rather than coercing. */
export function parseSdatDate(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null || !/^\d{8}$/.test(raw)) return null;

  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  if (year < 1700 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  /* Round-trip check catches 20250230 and friends, which Date would happily roll forward. */
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function propertyRef(
  attributes: Record<string, unknown>,
  centroid: [number, number] | null,
): PropertyRef {
  const block = asString(attributes['BLOCK']);
  const lot = asString(attributes['LOT']);
  return {
    apn: asString(attributes['ACCTID']),
    /* Baltimore BLOCKLOT is block + zero-padded lot, matching the form the city's own layers
       publish (e.g. "0702 050"). */
    blocklot: block !== null && lot !== null ? `${block} ${lot.padStart(3, '0')}` : null,
    addressLine1: asString(attributes['ADDRESS']) ?? '',
    addressLine2: null,
    city: asString(attributes['CITY']) ?? 'BALTIMORE',
    stateCode: 'MD',
    postalCode: asString(attributes['ZIPCODE']),
    centroid,
    /* No owner name in this source — see the note above. */
    ownerName: null,
  };
}

/**
 * Pure. No I/O, no clock, no database. Spec §9.1 MUST.
 *
 * `observedAt` comes from the record, not from `Date.now()` — a normalizer that reads the
 * clock is not a pure function and its golden fixture would drift every run.
 */
export function normalizeSdatParcelPoint(raw: RawRecord): NormalizedFact[] {
  const attributes = raw.payload;
  const centroidValue = attributes['__centroid'];
  const centroid =
    Array.isArray(centroidValue) && centroidValue.length === 2
      ? ([Number(centroidValue[0]), Number(centroidValue[1])] as [number, number])
      : null;

  const subject = propertyRef(attributes, centroid);
  if (subject.apn === null && subject.addressLine1 === '') return [];

  const observedAt = raw.observedAt;
  const facts: NormalizedFact[] = [];

  const add = (predicate: string, value: unknown, confidence = 0.95): void => {
    if (value === null || value === undefined) return;
    facts.push({ subject, predicate, value, epistemic: 'fact', observedAt, confidence });
  };

  add('property.year_built', asNumber(attributes['YEARBLT']));
  add('property.building_sqft', asNumber(attributes['SQFTSTRC']));
  add('property.assessed_value_cents', dollarsToCents(attributes['NFMTTLVL']));
  add('property.last_sale_date', parseSdatDate(attributes['TRADATE']));
  add('property.last_sale_price_cents', dollarsToCents(attributes['CONSIDR1']));
  add('land.use_code', asString(attributes['DESCLU']));

  const ownerLine1 = asString(attributes['OWNADD1']);
  const ownerCity = asString(attributes['OWNCITY']);
  const ownerState = asString(attributes['OWNSTATE']);
  /*
   * SDAT's `OWNERZIP` is not always a ZIP. On 0.51% of Baltimore records (1,201 of 237,260) it is
   * blank or shorter than five characters, and the `owner.mailing_address` schema requires five.
   *
   * The fix belongs HERE rather than in the schema. A short ZIP is missing data, and a record
   * with missing data should produce fewer facts, not an invalid one — spec §9.1 makes
   * `normalize` the place where a source's quirks are absorbed. Emitting it and letting
   * `recordFact` reject it turns one bad field into a whole rejected record, and in the batched
   * write path it also rolled back the record's 499 blameless neighbours: at 0.51% incidence,
   * **92% of 500-record chunks contained at least one**, so essentially every chunk fell back to
   * the sequential path and the batching bought nothing.
   *
   * Loosening the schema to `minLength: 0` was the other option and is worse — `postal_code` is
   * required precisely because mail goes to it.
   */
  const rawZip = asString(attributes['OWNERZIP']);
  const ownerZip = rawZip !== null && rawZip.trim().length >= 5 ? rawZip.trim() : null;

  if (ownerLine1 !== null && ownerCity !== null && ownerState !== null && ownerZip !== null) {
    /* Normalized here so `owner.absentee` can compare it to the property address without
       re-parsing, and so the same mailing address from two sources compares equal. */
    add('owner.mailing_address', {
      line1: normalizeAddress(ownerLine1).normalized,
      line2: asString(attributes['OWNADD2']),
      city: ownerCity.toUpperCase(),
      state: ownerState.toUpperCase(),
      postal_code: ownerZip,
    });
  }

  return facts;
}

export interface SdatAdapterOptions {
  userAgent: string;
  baseUrl?: string;
  pageSize?: number;
}

export function createSdatParcelPointsAdapter(options: SdatAdapterOptions): DataSourceAdapter {
  const layer: ArcGisLayer = {
    url:
      options.baseUrl ??
      'https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_PropertyData/MapServer/0',
    /* Service reports maxRecordCount 2000. The data.gov catalogue claims 65000; the live
       service is what counts. */
    pageSize: options.pageSize ?? 2000,
    userAgent: options.userAgent,
  };

  return {
    key: 'md.sdat_parcel_points',
    tier: 'official_record',
    scrapingAllowed: true,
    costModel: { perCallCents: 0, monthlyCents: 0 },

    async *fetch(_cursor, signal) {
      for await (const { attributes, centroid } of queryAll(
        layer,
        { where: `JURSCODE='${BALTIMORE_CITY}'`, outFields: SDAT_FIELDS },
        signal,
      )) {
        yield {
          sourceKey: 'md.sdat_parcel_points',
          sourceRecordId: asString(attributes['ACCTID']),
          payload: { ...attributes, __centroid: centroid },
          /* SDAT publishes monthly without a per-record timestamp, so the fetch time is the
             best available observation time. Recorded explicitly rather than defaulted. */
          observedAt: new Date(),
        };
      }
    },

    normalize: normalizeSdatParcelPoint,

    async healthCheck(): Promise<HealthStatus> {
      const controller = new AbortController();
      try {
        const count = await layerCount(layer, `JURSCODE='${BALTIMORE_CITY}'`, controller.signal);
        return {
          ok: count > 0,
          detail: `${String(count)} Baltimore City parcels`,
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
