/**
 * Shared ArcGIS REST client.
 *
 * The verification pass (docs/SOURCE_VERIFICATION.md) established that the Baltimore sources
 * are layers on ONE FeatureServer and that SDAT parcel points is a MapServer on a different
 * host. Both speak the same query protocol, so this is one client with many normalizers rather
 * than one client per source.
 *
 * It handles the three things verification actually observed going wrong:
 *   - `maxRecordCount` differs per service (1000 for the Baltimore service, 2000 for SDAT),
 *     and responses signal truncation with `exceededTransferLimit`
 *   - dates arrive as epoch milliseconds, which is where a manual conversion during
 *     verification was misread by three months
 *   - `geodata.md.gov` returned 503 while `mdgeodata.md.gov` served the same layer
 */

export interface ArcGisLayer {
  /** Full layer URL, e.g. `.../FeatureServer/1` or `.../MapServer/0`. */
  url: string;
  /** Must not exceed the service's own maxRecordCount. */
  pageSize: number;
  /** Spec §4.5 MUST: descriptive, with a contact address. */
  userAgent: string;
  /** Spec §4.5 MUST: <= 1 request/second per host by default. */
  minIntervalMs?: number;
}

export interface ArcGisQuery {
  where?: string;
  outFields?: string;
  returnGeometry?: boolean;
}

interface ArcGisFeature {
  attributes?: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcGisResponse {
  features?: ArcGisFeature[];
  exceededTransferLimit?: boolean;
  error?: { code?: number; message?: string; details?: string[] };
}

export class ArcGisError extends Error {
  constructor(url: string, detail: string) {
    super(`ArcGIS request failed for ${url}: ${detail}`);
    this.name = 'ArcGisError';
  }
}

/**
 * Convert an ArcGIS date field to a `Date`.
 *
 * ArcGIS returns dates as epoch **milliseconds**, and null for absent ones. This exists as a
 * named, separately-tested function because getting it wrong is silent: a wrong-but-plausible
 * date does not throw, it just makes every downstream signal wrong. During source verification
 * exactly that happened by hand and produced a confident, false conclusion.
 */
export function epochToDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  /* ArcGIS uses 0 for "no date" about as often as it means 1970-01-01. Treat it as absent —
     a 1970 timestamp in a Baltimore property feed is never real data. */
  if (value === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Read a field as a trimmed non-empty string, or null. */
export function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Read a field as a finite number, or null. Empty strings and sentinels become null. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Dollars to integer cents. CLAUDE.md: money is integer cents, never float. */
export function dollarsToCents(value: unknown): number | null {
  const dollars = asNumber(value);
  return dollars === null ? null : Math.round(dollars * 100);
}

class RateLimiter {
  private last = 0;
  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const elapsed = Date.now() - this.last;
    if (elapsed < this.minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.last = Date.now();
  }
}

function buildUrl(layer: ArcGisLayer, query: ArcGisQuery, offset: number): string {
  const params = new URLSearchParams({
    where: query.where ?? '1=1',
    outFields: query.outFields ?? '*',
    returnGeometry: String(query.returnGeometry ?? true),
    outSR: '4326',
    resultOffset: String(offset),
    resultRecordCount: String(layer.pageSize),
    f: 'json',
  });
  return `${layer.url}/query?${params.toString()}`;
}

/**
 * Page through every feature matching a query.
 *
 * Pagination is driven by `exceededTransferLimit` rather than by comparing the returned count
 * to `pageSize` — a final page that happens to be exactly `pageSize` long would otherwise stop
 * the walk one page early and silently drop records.
 */
export async function* queryAll(
  layer: ArcGisLayer,
  query: ArcGisQuery,
  signal: AbortSignal,
): AsyncIterable<{ attributes: Record<string, unknown>; centroid: [number, number] | null }> {
  const limiter = new RateLimiter(layer.minIntervalMs ?? 1000);
  let offset = 0;

  for (;;) {
    signal.throwIfAborted();
    await limiter.wait();

    const url = buildUrl(layer, query, offset);
    const response = await fetch(url, {
      signal,
      headers: { 'User-Agent': layer.userAgent, Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new ArcGisError(layer.url, `HTTP ${String(response.status)}`);
    }

    const body = (await response.json()) as ArcGisResponse;

    /* ArcGIS reports errors with HTTP 200 and an `error` object, so a status check alone is
       not enough to know the request worked. */
    if (body.error !== undefined) {
      const detail = body.error.message ?? 'unknown error';
      throw new ArcGisError(layer.url, `${detail}${(body.error.details ?? []).join('; ')}`);
    }

    const features = body.features ?? [];
    for (const feature of features) {
      const attributes = feature.attributes ?? {};
      const x = feature.geometry?.x;
      const y = feature.geometry?.y;
      const centroid: [number, number] | null =
        typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)
          ? [x, y]
          : null;
      yield { attributes, centroid };
    }

    if (body.exceededTransferLimit !== true || features.length === 0) return;
    offset += features.length;
  }
}

/** Cheap liveness probe: ask the layer for its record count. */
export async function layerCount(
  layer: ArcGisLayer,
  where: string,
  signal: AbortSignal,
): Promise<number> {
  const params = new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' });
  const url = `${layer.url}/query?${params.toString()}`;
  const response = await fetch(url, {
    signal,
    headers: { 'User-Agent': layer.userAgent, Accept: 'application/json' },
  });
  if (!response.ok) throw new ArcGisError(layer.url, `HTTP ${String(response.status)}`);

  const body = (await response.json()) as { count?: number; error?: { message?: string } };
  if (body.error !== undefined) {
    throw new ArcGisError(layer.url, body.error.message ?? 'unknown error');
  }
  return body.count ?? 0;
}
