import type { Db } from '@magnolia/db';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import type IORedis from 'ioredis';

/**
 * Fastify server.
 *
 * At this stage it carries the operational endpoints only — the REST surface arrives with
 * BUILD_PLAN M7 (inbound comms webhooks) and M8 (dashboard). What exists here is what a
 * container orchestrator needs in order to run the thing at all, which is infrastructure rather
 * than product.
 *
 * `/health` and `/ready` are deliberately different checks, because conflating them causes a
 * specific and nasty outage: if the liveness probe also tested the database, then a brief
 * Postgres blip would make every replica "unhealthy", the orchestrator would kill them all, and
 * the restarts would hit the recovering database at once. Liveness answers "is this process
 * wedged?"; readiness answers "should traffic come here right now?".
 */

export interface ServerOptions {
  db: Db;
  redis: IORedis;
  /** Stamped into `/health` so a rolling deploy can be observed replica by replica. */
  version?: string;
}

export interface DependencyStatus {
  ok: boolean;
  detail: string;
  ms: number;
}

/**
 * How long a dependency gets to answer before it is called down.
 *
 * A readiness probe that hangs is worse than one that reports a failure: the orchestrator's own
 * probe times out, the endpoint returns nothing at all, and a *degraded* dependency reads as a
 * *wedged* process. That is not hypothetical — the first version of this file had no timeout,
 * and with Redis stopped `/ready` returned no response rather than 503.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Timed round-trip to a dependency. Never throws and never hangs — a failure IS the answer.
 *
 * The timeout is here rather than only in the client config because it has to hold whatever the
 * client does. ioredis queues commands while disconnected, `pg` has its own notion of timeouts,
 * and a future dependency will have a third; the probe's contract is that it always answers
 * within the budget regardless.
 */
async function probe(name: string, run: () => Promise<unknown>): Promise<DependencyStatus> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${name} did not respond within ${String(PROBE_TIMEOUT_MS)}ms`));
        }, PROBE_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, detail: `${name} ok`, ms: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({
    /* Fastify's own logger is disabled: the worker and the API should produce the same shape of
       line, and Fastify's default pino output does not match `createLogger`. Request logging
       arrives with the real routes in M7/M8. */
    logger: false,
    /* Behind a load balancer the client IP and protocol arrive in headers. Compliance decisions
       never depend on them, but rate limiting and audit records will. */
    trustProxy: true,
    /* Fastify's default is 100 MB, which is a denial-of-service surface for an API whose largest
       legitimate body is a manual-upload CSV. */
    bodyLimit: 8 * 1024 * 1024,
  });

  /**
   * Liveness. No dependencies touched, on purpose — see the note above.
   *
   * A 200 here means the event loop is turning and the process can serve a request. If that is
   * false the process is unrecoverable and deserves a restart; anything else does not.
   */
  app.get('/health', () => ({
    status: 'ok',
    app: 'magnolia-api',
    version: options.version ?? 'dev',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  /**
   * Readiness. Checks the dependencies a request actually needs.
   *
   * Returns 503 when any of them is down, which takes this replica out of the load-balancer pool
   * without killing it — so it rejoins by itself when the dependency recovers, with no restart
   * and no thundering herd.
   */
  app.get('/ready', async (_request, reply) => {
    const [database, redis] = await Promise.all([
      probe('postgres', () => options.db.execute(sql`SELECT 1`)),
      probe('redis', () => options.redis.ping()),
    ]);

    const ready = database.ok && redis.ok;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: { database, redis },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({ error: 'not_found', path: request.url });
  });

  return app;
}
