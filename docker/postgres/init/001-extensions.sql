-- Extensions required by the Magnolia data architecture.
--
-- postgis / postgis_topology : parcel geometry, centroid distance checks, ST_Touches
--                              adjacency precompute (spec §4.4 land.adjacent_cluster,
--                              BUILD_PLAN M2.5).
-- pg_trgm                    : trigram similarity for entity resolution — properties match on
--                              fuzzy address >= 0.92, persons on fuzzy name >= 0.95 (spec §4.3).
-- citext                     : case-insensitive natural keys (source keys, predicate names).
-- pgcrypto                   : gen_random_uuid() for primary keys.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
