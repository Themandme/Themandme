import { z } from 'zod';

/**
 * Boot-time environment validation.
 *
 * BUILD_PLAN M0.5: "Zod-validated config loader that throws at boot on a missing var — never a
 * silent default." Nothing in this file may call `.default()`. `env.test.ts` asserts that
 * mechanically by walking the schema, so the rule survives future edits.
 */

export const MAGNOLIA_ENVS = ['local', 'staging', 'production'] as const;
export type MagnoliaEnv = (typeof MAGNOLIA_ENVS)[number];

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration (${String(issues.length)} problem${
        issues.length === 1 ? '' : 's'
      }):\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

/**
 * Credentials whose *presence* is itself environment-dependent.
 *
 * The comms group is the load-bearing one. Spec §3.2 requires that outbound is impossible in
 * local and staging by construction rather than by flag, so having the credentials in the
 * process at all is treated as a misconfiguration.
 */
type Presence = 'required' | 'optional' | 'forbidden';

interface CredentialGroup {
  readonly label: string;
  readonly rationale: string;
  readonly vars: readonly string[];
  readonly presence: Readonly<Record<MagnoliaEnv, Presence>>;
}

export const CREDENTIAL_GROUPS: readonly CredentialGroup[] = [
  {
    label: 'communications',
    rationale:
      'Spec §3.2: in local and staging, CommsProvider implementations are physically absent. Blocking outbound must not depend on a runtime flag being set correctly.',
    vars: [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_MESSAGING_SERVICE_SID',
      'TWILIO_VOICE_NUMBER',
      'LOB_API_KEY',
      'POSTMARK_SERVER_TOKEN',
      'BLAND_API_KEY',
      'MAGNOLIA_PUBLIC_VOICE_NUMBER',
    ],
    presence: { local: 'forbidden', staging: 'forbidden', production: 'required' },
  },
  {
    label: 'paid data (T3)',
    rationale:
      'Spec §5.1/§9.2: per-lookup billing. Local runs against fakes, so real credentials there are a misconfiguration.',
    vars: ['SKIPTRACE_API_KEY', 'PHONE_VALIDATION_API_KEY'],
    presence: { local: 'forbidden', staging: 'optional', production: 'required' },
  },
  {
    label: 'LLM',
    rationale: 'Spec §3.2: local fakes every provider; staging and production call the real API.',
    vars: ['ANTHROPIC_API_KEY'],
    presence: { local: 'optional', staging: 'required', production: 'required' },
  },
  {
    label: 'observability',
    rationale: 'Spec §3: structured logs + Sentry are the whole V1 observability story.',
    vars: ['SENTRY_DSN'],
    presence: { local: 'optional', staging: 'required', production: 'required' },
  },
];

const nonEmpty = z.string().min(1);

export const EnvSchema = z.object({
  MAGNOLIA_ENV: z.enum(MAGNOLIA_ENVS),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']),

  API_HOST: nonEmpty,
  API_PORT: z.coerce.number().int().positive().max(65535),
  API_BASE_URL: z.string().url(),
  WEB_BASE_URL: z.string().url(),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters; generate with `openssl rand -hex 32`'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: nonEmpty,
  S3_BUCKET: nonEmpty,
  S3_ACCESS_KEY_ID: nonEmpty,
  S3_SECRET_ACCESS_KEY: nonEmpty,

  OUTBOUND_USER_AGENT: nonEmpty,

  /* Presence governed by CREDENTIAL_GROUPS, so the shape only constrains the value. */
  ANTHROPIC_API_KEY: nonEmpty.optional(),
  SENTRY_DSN: nonEmpty.optional(),
  TWILIO_ACCOUNT_SID: nonEmpty.optional(),
  TWILIO_AUTH_TOKEN: nonEmpty.optional(),
  TWILIO_MESSAGING_SERVICE_SID: nonEmpty.optional(),
  TWILIO_VOICE_NUMBER: nonEmpty.optional(),
  LOB_API_KEY: nonEmpty.optional(),
  POSTMARK_SERVER_TOKEN: nonEmpty.optional(),
  BLAND_API_KEY: nonEmpty.optional(),
  MAGNOLIA_PUBLIC_VOICE_NUMBER: nonEmpty.optional(),
  SKIPTRACE_API_KEY: nonEmpty.optional(),
  PHONE_VALIDATION_API_KEY: nonEmpty.optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/** An unset variable and an empty/whitespace-only one are the same thing: absent. */
function compact(source: EnvSource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') {
      out[key] = value;
    }
  }
  return out;
}

function checkCredentialGroups(env: MagnoliaEnv, source: EnvSource): string[] {
  const issues: string[] = [];

  for (const group of CREDENTIAL_GROUPS) {
    const presence = group.presence[env];
    if (presence === 'optional') continue;

    for (const name of group.vars) {
      const isPresent = source[name] !== undefined;

      if (presence === 'required' && !isPresent) {
        issues.push(
          `${name}: required when MAGNOLIA_ENV=${env} [${group.label}]. ${group.rationale}`,
        );
      } else if (presence === 'forbidden' && isPresent) {
        issues.push(
          `${name}: MUST NOT be set when MAGNOLIA_ENV=${env} [${group.label}]. ${group.rationale}`,
        );
      }
    }
  }

  return issues;
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    const name = path === '' ? '(root)' : path;
    return issue.code === 'invalid_type' && issue.received === 'undefined'
      ? `${name}: required, but not set`
      : `${name}: ${issue.message}`;
  });
}

/**
 * Validate and return the environment, or throw a single `ConfigurationError` listing every
 * problem at once. Reporting one variable per run turns a first deploy into a guessing game.
 */
export function loadEnv(source: EnvSource = process.env): Env {
  const compacted = compact(source);

  /* MAGNOLIA_ENV selects the presence rules for everything else, so it is validated first and
     on its own — the remaining errors are meaningless without it. */
  const envParse = z.enum(MAGNOLIA_ENVS).safeParse(compacted['MAGNOLIA_ENV']);
  if (!envParse.success) {
    const received = compacted['MAGNOLIA_ENV'];
    throw new ConfigurationError([
      `MAGNOLIA_ENV: must be one of ${MAGNOLIA_ENVS.join(' | ')} (received ${
        received === undefined ? 'nothing' : `"${received}"`
      }). It selects every other rule, so it is validated first.`,
    ]);
  }

  const parsed = EnvSchema.safeParse(compacted);
  const groupIssues = checkCredentialGroups(envParse.data, compacted);

  if (!parsed.success) {
    throw new ConfigurationError([...formatZodIssues(parsed.error), ...groupIssues]);
  }
  if (groupIssues.length > 0) {
    throw new ConfigurationError(groupIssues);
  }

  return parsed.data;
}
