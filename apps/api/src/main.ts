import { loadEnv } from '@magnolia/config';
import { closeDb, createDb } from '@magnolia/db';
import IORedis from 'ioredis';
import { createServer } from './server.js';

/**
 * API entrypoint.
 *
 * Mirrors the worker's boot sequence deliberately: validate the environment before opening any
 * connection, then start, then handle signals. Two processes that fail differently on a bad
 * config are two processes to debug.
 */

async function main(): Promise<void> {
  const env = loadEnv(process.env);

  const db = createDb(env.DATABASE_URL);
  const redis = new IORedis(env.REDIS_URL, {
    /*
     * NOT `maxRetriesPerRequest: null`. That setting is a BullMQ requirement — its blocking
     * commands must never be abandoned — and it is wrong here: it makes an ordinary command
     * queue indefinitely while disconnected. The API's only use of this client is the readiness
     * probe, which must FAIL when Redis is down, not wait for it to return.
     */
    maxRetriesPerRequest: 1,
    /* Same reasoning: with the offline queue on, `ping()` is buffered until reconnection rather
       than rejecting, so a down Redis produces a hang instead of a 503. */
    enableOfflineQueue: false,
    connectTimeout: 2_000,
  });
  /* ioredis emits `error` on every failed reconnect; unhandled, that is a crash. The readiness
     probe is what reports the condition, so here it only needs to not be fatal. */
  redis.on('error', (error: Error) => {
    process.stderr.write(
      `${JSON.stringify({ at: new Date().toISOString(), level: 'warn', msg: 'redis error', error: error.message })}\n`,
    );
  });

  const app = createServer({ db, redis, version: process.env['GIT_SHA'] ?? 'dev' });

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  process.stderr.write(
    `${JSON.stringify({
      at: new Date().toISOString(),
      level: 'info',
      msg: 'api listening',
      host: env.API_HOST,
      port: env.API_PORT,
      env: env.MAGNOLIA_ENV,
    })}\n`,
  );

  let shuttingDown = false;
  /* Signal-agnostic on purpose: SIGTERM and SIGINT get identical treatment, and the worker's
     logger is not available here to record which arrived. */
  const shutdown = (): void => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;

    void (async () => {
      try {
        /* Fastify's close drains in-flight requests before resolving, so a rolling deploy does
           not cut a response in half. */
        await app.close();
        redis.disconnect();
        await closeDb(db);
        process.exit(0);
      } catch {
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `api failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
