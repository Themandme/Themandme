import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigurationError, EnvSchema, loadEnv } from '../env.js';

/** A complete, valid `local` environment. Individual tests remove or add one key at a time. */
function localEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    MAGNOLIA_ENV: 'local',
    LOG_LEVEL: 'info',
    API_HOST: '0.0.0.0',
    API_PORT: '3001',
    API_BASE_URL: 'http://localhost:3001',
    WEB_BASE_URL: 'http://localhost:3000',
    SESSION_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgres://magnolia:magnolia@localhost:5432/magnolia',
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'auto',
    S3_BUCKET: 'magnolia-local',
    S3_ACCESS_KEY_ID: 'local-access-key',
    S3_SECRET_ACCESS_KEY: 'local-secret-key',
    OUTBOUND_USER_AGENT: 'Magnolia/0.1 (+mailto:ops@example.com)',
  };

  /* An override of `undefined` removes the key, which is how tests express "this variable is
     not set" as distinct from "this variable is empty". */
  const merged: Record<string, string | undefined> = { ...base, ...overrides };
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function productionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  return localEnv({
    MAGNOLIA_ENV: 'production',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    SENTRY_DSN: 'https://public@sentry.example.com/1',
    TWILIO_ACCOUNT_SID: 'AC-test',
    TWILIO_AUTH_TOKEN: 'token',
    TWILIO_MESSAGING_SERVICE_SID: 'MG-test',
    TWILIO_VOICE_NUMBER: '+14105550100',
    LOB_API_KEY: 'lob-test',
    POSTMARK_SERVER_TOKEN: 'postmark-test',
    BLAND_API_KEY: 'bland-test',
    MAGNOLIA_PUBLIC_VOICE_NUMBER: '+14105550199',
    SKIPTRACE_API_KEY: 'skiptrace-test',
    PHONE_VALIDATION_API_KEY: 'phone-test',
    ...overrides,
  });
}

/** Collect the issue list from a `loadEnv` call that is expected to throw. */
function issuesFrom(source: Record<string, string | undefined>): string[] {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof ConfigurationError) return [...error.issues];
    throw error;
  }
  throw new Error('expected loadEnv to throw, but it returned successfully');
}

describe('loadEnv — happy path', () => {
  it('accepts a complete local environment and coerces the port to a number', () => {
    const env = loadEnv(localEnv());
    expect(env.MAGNOLIA_ENV).toBe('local');
    expect(env.API_PORT).toBe(3001);
    expect(typeof env.API_PORT).toBe('number');
  });

  it('accepts a complete production environment', () => {
    const env = loadEnv(productionEnv());
    expect(env.MAGNOLIA_ENV).toBe('production');
    expect(env.TWILIO_ACCOUNT_SID).toBe('AC-test');
  });

  it('ignores unrelated variables present in the source', () => {
    expect(() => loadEnv(localEnv({ HOME: '/root', PATH: '/usr/bin' }))).not.toThrow();
  });
});

describe('loadEnv — throws rather than defaulting', () => {
  it('throws naming a missing required variable', () => {
    const issues = issuesFrom(localEnv({ DATABASE_URL: undefined }));
    expect(issues).toContainEqual(expect.stringContaining('DATABASE_URL'));
  });

  it('reports every missing variable at once, not just the first', () => {
    const issues = issuesFrom(
      localEnv({ DATABASE_URL: undefined, REDIS_URL: undefined, S3_BUCKET: undefined }),
    );
    expect(issues).toContainEqual(expect.stringContaining('DATABASE_URL'));
    expect(issues).toContainEqual(expect.stringContaining('REDIS_URL'));
    expect(issues).toContainEqual(expect.stringContaining('S3_BUCKET'));
  });

  it('treats an empty or whitespace-only value as absent', () => {
    expect(issuesFrom(localEnv({ DATABASE_URL: '' }))).toContainEqual(
      expect.stringContaining('DATABASE_URL'),
    );
    expect(issuesFrom(localEnv({ DATABASE_URL: '   ' }))).toContainEqual(
      expect.stringContaining('DATABASE_URL'),
    );
  });

  it('rejects a malformed value as firmly as a missing one', () => {
    expect(issuesFrom(localEnv({ DATABASE_URL: 'not-a-url' }))).toContainEqual(
      expect.stringContaining('DATABASE_URL'),
    );
    expect(issuesFrom(localEnv({ SESSION_SECRET: 'too-short' }))).toContainEqual(
      expect.stringContaining('SESSION_SECRET'),
    );
  });

  it('validates MAGNOLIA_ENV first, since it selects every other rule', () => {
    const issues = issuesFrom(localEnv({ MAGNOLIA_ENV: 'prod', DATABASE_URL: undefined }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('MAGNOLIA_ENV');
  });

  it('declares no defaults anywhere in the schema', () => {
    /* BUILD_PLAN M0.5: "never a silent default". Asserted structurally so the rule cannot be
       quietly broken by a later edit adding `.default()` to one key. */
    const containsDefault = (schema: z.ZodTypeAny): boolean => {
      if (schema instanceof z.ZodDefault) return true;
      if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
        return containsDefault(schema.unwrap() as z.ZodTypeAny);
      }
      return false;
    };

    for (const [key, schema] of Object.entries(EnvSchema.shape)) {
      expect(containsDefault(schema as z.ZodTypeAny), `${key} must not declare a default`).toBe(
        false,
      );
    }
  });
});

describe('loadEnv — comms credentials are environment-gated (spec §3.2)', () => {
  it.each(['local', 'staging'] as const)(
    'rejects a comms credential present in %s',
    (magnoliaEnv) => {
      const source = localEnv({
        MAGNOLIA_ENV: magnoliaEnv,
        TWILIO_ACCOUNT_SID: 'AC-oops',
        ...(magnoliaEnv === 'staging'
          ? { ANTHROPIC_API_KEY: 'sk-ant-test', SENTRY_DSN: 'https://public@sentry.example.com/1' }
          : {}),
      });
      const issues = issuesFrom(source);
      expect(issues).toContainEqual(expect.stringContaining('TWILIO_ACCOUNT_SID'));
      expect(issues).toContainEqual(expect.stringContaining('MUST NOT be set'));
    },
  );

  it('rejects a paid-data credential present in local', () => {
    expect(issuesFrom(localEnv({ SKIPTRACE_API_KEY: 'oops' }))).toContainEqual(
      expect.stringContaining('SKIPTRACE_API_KEY'),
    );
  });

  it('requires every comms credential in production', () => {
    const issues = issuesFrom(productionEnv({ LOB_API_KEY: undefined, BLAND_API_KEY: undefined }));
    expect(issues).toContainEqual(expect.stringContaining('LOB_API_KEY'));
    expect(issues).toContainEqual(expect.stringContaining('BLAND_API_KEY'));
  });

  it('allows the LLM key to be absent in local but requires it in staging', () => {
    expect(() => loadEnv(localEnv())).not.toThrow();

    const issues = issuesFrom(
      localEnv({ MAGNOLIA_ENV: 'staging', SENTRY_DSN: 'https://public@sentry.example.com/1' }),
    );
    expect(issues).toContainEqual(expect.stringContaining('ANTHROPIC_API_KEY'));
  });
});
