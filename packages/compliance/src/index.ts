/**
 * @magnolia/compliance — rule engine and Maryland rule pack.
 *
 * Spec §8: this is the ONLY package permitted to authorize an outbound communication, a
 * binding transaction transition, or a spend commitment above $1.00. Every other package
 * calls it. The ESLint boundary in `eslint.config.mjs` is what keeps that true.
 *
 * Populated by BUILD_PLAN M4, which must land before any comms code (M7).
 */

export const PACKAGE_NAME = '@magnolia/compliance';
