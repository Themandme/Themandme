-- Extensions required by the Magnolia schema.
--
-- This list mirrors the CREATE EXTENSION block at the top of `schema.sql`, which is the
-- source of truth. Keep the two in sync — an extension present here but not there is
-- over-provisioning, and the reverse breaks migrations.
--
-- postgis  : parcel geometry (`parcels.geom`), property centroids, GiST indexes, and the
--            ST_Touches adjacency precompute behind `parcel_adjacency`.
-- pg_trgm  : trigram similarity for entity resolution — the GIN indexes on
--            `properties.address_norm` and `persons.name_norm`. Spec §4.3 matches properties
--            on fuzzy address >= 0.92 and persons on fuzzy name >= 0.95.
-- pgcrypto : digest()/gen_random_bytes() for the sha256 hashes stored as bytea
--            (`properties.address_hash`, `contacts.value_hash`, `suppressions.contact_hash`).
--
-- Note: ids are UUID v7 (time-ordered) generated in the application layer. schema.sql leaves
-- `pg_uuidv7` commented out because it is not available in the stock postgis image.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
