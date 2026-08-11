/**
 * `pnpm env:check` — validate the current environment and exit non-zero if it is not bootable.
 *
 * The same `loadEnv` the apps call at startup, so a green run here means the apps will boot
 * rather than fail three seconds later in a container.
 */

import { ConfigurationError, loadEnv } from './index.js';

try {
  const env = loadEnv();
  process.stdout.write(`environment is valid for MAGNOLIA_ENV=${env.MAGNOLIA_ENV}\n`);
} catch (error) {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
