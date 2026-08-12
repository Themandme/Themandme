import { loadEnv } from '@magnolia/config';
import { loadPredicateRegistry, projectAll } from '@magnolia/core';
import { closeDb, createDb } from '@magnolia/db';
import { createLogger } from './logger.js';

/**
 * Recompute the read model for every property.
 *
 * `pnpm reproject` — BUILD_PLAN M1.5's repair path, made runnable.
 *
 * The read model is a pure function of current facts, so this is always safe and always
 * idempotent. Use it when a projection is suspected wrong, or after an interruption left facts
 * written and `properties` stale.
 */
const env = loadEnv(process.env);
const log = createLogger(env.LOG_LEVEL, { app: 'reproject' });
const db = createDb(env.DATABASE_URL);

const started = Date.now();
const registry = await loadPredicateRegistry(db);
const { projected } = await projectAll(db, registry);
const ms = Date.now() - started;

log.info('reprojected', {
  properties: projected,
  seconds: Math.round(ms / 1000),
  perSecond: ms > 0 ? Math.round((projected / ms) * 1000) : 0,
});
await closeDb(db);
