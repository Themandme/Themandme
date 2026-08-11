import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * The vendor-SDK containment boundary is an invariant expressed as lint configuration
 * (CLAUDE.md: "No package outside `packages/providers` imports a vendor SDK. ESLint enforces
 * this."). A lint rule nobody tests is a lint rule that silently stops working after a config
 * refactor, so this asserts the real `eslint.config.mjs` resolves the way it claims to.
 *
 * `calculateConfigForFile` resolves the flat config for a path without needing the file to
 * exist and without type information, so this stays fast and does not depend on the probe
 * paths being real files.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const RestrictedImportsEntry = z.tuple([
  z.union([z.number(), z.string()]),
  z.object({
    patterns: z.array(z.object({ group: z.array(z.string()) })),
  }),
]);

/* `calculateConfigForFile` is typed as `any`, so narrow it before reading anything. */
const ResolvedConfig = z.object({ rules: z.record(z.string(), z.unknown()).optional() });

async function ruleEntryFor(relativePath: string, ruleName: string): Promise<unknown> {
  const eslint = new ESLint({ cwd: repoRoot });
  const resolved: unknown = await eslint.calculateConfigForFile(path.join(repoRoot, relativePath));
  const parsed = ResolvedConfig.safeParse(resolved);
  return parsed.success ? parsed.data.rules?.[ruleName] : undefined;
}

interface Boundary {
  readonly enabled: boolean;
  readonly groups: readonly string[];
}

async function boundaryFor(relativePath: string): Promise<Boundary> {
  const entry = await ruleEntryFor(relativePath, 'no-restricted-imports');

  /* `'off'` normalises to a severity-only array, which fails the tuple parse — that is the
     disabled case, not a malformed config. */
  const parsed = RestrictedImportsEntry.safeParse(entry);
  if (!parsed.success) {
    return { enabled: false, groups: [] };
  }

  const [severity, options] = parsed.data;
  if (severity === 0 || severity === 'off') {
    return { enabled: false, groups: [] };
  }

  return {
    enabled: true,
    groups: options.patterns.flatMap((pattern) => pattern.group),
  };
}

describe('vendor SDK containment', () => {
  it('bars comms and non-comms SDKs from an ordinary package', async () => {
    const boundary = await boundaryFor('packages/core/src/probe.ts');
    expect(boundary.enabled).toBe(true);
    expect(boundary.groups).toContain('twilio');
    expect(boundary.groups).toContain('@lob/*');
    expect(boundary.groups).toContain('@anthropic-ai/*');
  });

  it('bars them from apps too', async () => {
    const boundary = await boundaryFor('apps/api/src/probe.ts');
    expect(boundary.enabled).toBe(true);
    expect(boundary.groups).toContain('twilio');
    expect(boundary.groups).toContain('@anthropic-ai/*');
  });

  it('permits every vendor SDK inside packages/providers', async () => {
    const boundary = await boundaryFor('packages/providers/src/probe.ts');
    expect(boundary.enabled).toBe(false);
  });

  it('permits comms SDKs but not the LLM SDK inside packages/compliance', async () => {
    /* BUILD_PLAN M0.4 allows comms here; CLAUDE.md confines everything else to providers. */
    const boundary = await boundaryFor('packages/compliance/src/probe.ts');
    expect(boundary.enabled).toBe(true);
    expect(boundary.groups).not.toContain('twilio');
    expect(boundary.groups).toContain('@anthropic-ai/*');
  });
});

describe('no-any enforcement', () => {
  it('sets @typescript-eslint/no-explicit-any to error in source packages', async () => {
    const severity = await ruleEntryFor(
      'packages/core/src/probe.ts',
      '@typescript-eslint/no-explicit-any',
    );
    const errorSeverity = z.union([z.literal(2), z.literal('error')]);
    const parsed = z.union([errorSeverity, z.tuple([errorSeverity])]).safeParse(severity);
    expect(parsed.success, `expected error severity, got ${JSON.stringify(severity)}`).toBe(true);
  });
});
