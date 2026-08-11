import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, createDb, type Db } from '@magnolia/db';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

/**
 * Scratch-database harness for DB-backed tests.
 *
 * Each test file gets its own database so files can run in parallel without seeing each
 * other's rows. Within a file, `truncateAll` resets between tests.
 *
 * These tests FAIL rather than skip when Postgres is unreachable. A skipped test and a passing
 * one look identical in a CI summary, and the whole posture of this codebase is that silence
 * is not consent — a suite that quietly stops covering the fact ledger is worse than a red one.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const ADMIN_URL =
  process.env['DATABASE_URL'] ?? 'postgres://magnolia:magnolia@localhost:5432/magnolia';

const UNREACHABLE = [
  'Cannot reach Postgres for a database-backed test.',
  '',
  `  tried: ${ADMIN_URL.replace(/:\/\/[^@]*@/, '://***@')}`,
  '',
  '  Start it with:  pnpm db:up',
  '  Then apply migrations:  pnpm --filter @magnolia/db migrate',
  '',
  'These tests do not skip when the database is missing — a skipped test is',
  'indistinguishable from a passing one, and this suite is the only thing checking',
  'the fact-ledger invariants.',
].join('\n');

function migrationSql(): string {
  const dir = path.join(repoRoot, 'packages/db/migrations');
  const file = readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8');
  const journal = JSON.parse(file) as { entries: { tag: string }[] };
  return journal.entries
    .map((entry) => readFileSync(path.join(dir, `${entry.tag}.sql`), 'utf8'))
    .join('\n')
    .replaceAll('--> statement-breakpoint', '');
}

export interface TestDb {
  db: Db;
  name: string;
  /** Delete every row while keeping the schema. Call between tests. */
  truncateAll: () => Promise<void>;
  drop: () => Promise<void>;
}

function scratchUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Create a fresh database named after the caller and apply all migrations.
 * `label` should be unique per test file.
 */
export async function createTestDb(label: string): Promise<TestDb> {
  const name = `mag_test_${label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 60);

  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${UNREACHABLE}\n\n  underlying error: ${detail}`);
  } finally {
    await admin.end();
  }

  const setup = postgres(scratchUrl(name), { max: 1, onnotice: () => undefined });
  try {
    await setup.unsafe(migrationSql());
  } finally {
    await setup.end();
  }

  const db = createDb(scratchUrl(name), { max: 4 });

  return {
    db,
    name,
    truncateAll: async () => {
      /* One statement, so FK order does not matter and it stays fast. */
      const rows = await db.execute<{ tables: string | null }>(sql`
        SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS tables
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('spatial_ref_sys', '__drizzle_migrations')
      `);
      const tables = rows[0]?.tables;
      if (tables !== null && tables !== undefined && tables !== '') {
        await db.execute(sql.raw(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`));
      }
    },
    drop: async () => {
      await closeDb(db);
      const cleanup = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
