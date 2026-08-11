import { defineConfig } from 'drizzle-kit';

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  throw new Error('DATABASE_URL is required to run drizzle-kit. See .env.example.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
