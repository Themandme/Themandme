/**
 * @magnolia/api — Fastify server, REST + webhooks.
 *
 * Currently the operational surface only (`/health`, `/ready`). The REST endpoints arrive with
 * BUILD_PLAN M7 (inbound comms webhooks) and M8 (operator dashboard).
 */

export const APP_NAME = '@magnolia/api';

export { createServer, type DependencyStatus, type ServerOptions } from './server.js';
