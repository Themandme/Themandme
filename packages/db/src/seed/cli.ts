/**
 * `pnpm --filter @magnolia/db seed`
 *
 * Applies the seed and prints a per-table report. A second run must print all zeros — that is
 * invariant 7 made observable rather than asserted.
 */

import { ConfigurationError, loadEnv } from '@magnolia/config';
import { closeDb, createDb } from '../client.js';
import { seed, totalChanges } from './index.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  try {
    const report = await seed(db);
    for (const [table, counts] of Object.entries(report)) {
      process.stdout.write(
        `${table.padEnd(16)} inserted=${String(counts.inserted).padStart(3)}  ` +
          `updated=${String(counts.updated).padStart(3)}  ` +
          `unchanged=${String(counts.unchanged).padStart(3)}\n`,
      );
    }
    const changed = totalChanges(report);
    process.stdout.write(
      changed === 0 ? '\nno changes — already seeded\n' : `\n${String(changed)} row(s) written\n`,
    );
  } finally {
    await closeDb(db);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
