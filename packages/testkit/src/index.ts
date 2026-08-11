/**
 * @magnolia/testkit — fixtures, factories, fake providers, golden files.
 *
 * Fakes for the provider interfaces arrive with the interfaces themselves (M2 onward).
 */

export { createTestDb, type TestDb } from './db.js';

export { baltimoreMarketId, createProperty, sourceIdByKey } from './fixtures.js';

export { createFixtureAdapter, type FixtureAdapterOptions } from './fake-adapter.js';
