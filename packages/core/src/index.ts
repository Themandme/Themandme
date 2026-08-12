/**
 * @magnolia/core — Domain types, fact ledger, signal engine, scoring, router.
 *
 * Populated by BUILD_PLAN M1-M3. M0 establishes the package boundary and its build,
 * lint and type rails only; no domain logic lives here yet.
 */

export const PACKAGE_NAME = '@magnolia/core';
export * from './facts/index.js';
export * from './read-model/index.js';
export * from './events/index.js';
export * from './addresses/index.js';
export * from './resolution/index.js';
export * from './scheduling/index.js';
