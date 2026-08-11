import { customType, numeric, timestamp } from 'drizzle-orm/pg-core';

/**
 * Column types Drizzle does not model the way `schema.sql` needs.
 *
 * Drizzle's built-in `geometry()` hardcodes `geometry(point)` — it drops the SRID and cannot
 * express MultiPolygon — so the two PostGIS columns are declared here to emit exactly what
 * `schema.sql` declares. Getting this wrong would silently change the storage type of
 * `parcels.geom` and lose the coordinate system on `properties.centroid`.
 */

/** `bytea`. Used for sha256 digests: address_hash, value_hash, contact_hash, token_hash. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/** `geometry(Point,4326)` — WGS84 lon/lat. Carried as WKT/EWKB text; M2 does the geometry work. */
export const geometryPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geometry(Point,4326)';
  },
});

/** `geometry(MultiPolygon,4326)` — parcel boundaries. */
export const geometryMultiPolygon = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geometry(MultiPolygon,4326)';
  },
});

/* ── Shared column shapes ──────────────────────────────────────────────────────────────
   `schema.sql` conventions: all timestamps are timestamptz stored UTC; all probabilities are
   numeric(5,4) in [0,1]. Money is deliberately NOT abstracted here — schema.sql uses `integer`
   cents in some places and `bigint` cents in others, and collapsing that would silently widen
   or narrow columns. Each money column is declared explicitly at its call site. */

/** `timestamptz`. */
export const ts = (name: string) => timestamp(name, { withTimezone: true });

/** `numeric(5,4)` in [0,1], surfaced as a JS number. */
export const probability = (name: string) =>
  numeric(name, { precision: 5, scale: 4, mode: 'number' });
