import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Vendor SDK containment.
 *
 * CLAUDE.md: "No package outside `packages/providers` imports a vendor SDK. ESLint enforces this."
 * Spec §9: all external dependencies sit behind an interface in `packages/providers`.
 * BUILD_PLAN M0.4 additionally names `packages/compliance` for comms providers.
 *
 * Those two statements differ, so this config takes the intersection:
 *   - comms SDKs   -> permitted in `packages/providers` AND `packages/compliance` (per BUILD_PLAN)
 *   - every other  -> permitted in `packages/providers` only (per CLAUDE.md, the stricter rule)
 *
 * Note the tension: `packages/compliance` authorizes sends, it does not perform them, so it
 * arguably should never need a comms SDK either. The allowance is here because BUILD_PLAN M0.4
 * asks for it; if it turns out to be unused by the end of M7, tighten this to providers-only.
 */
const COMMS_SDKS = ['twilio', 'twilio/*', 'lob', '@lob/*', 'postmark', 'bland-ai', '@bland-ai/*'];

const NON_COMMS_SDKS = [
  '@anthropic-ai/*',
  'openai',
  'cohere-ai',
  '@google/generative-ai',
  '@aws-sdk/*',
];

const BOUNDARY_MESSAGE =
  'Vendor SDKs may only be imported inside packages/providers (comms SDKs additionally inside packages/compliance). Depend on the interface, not the vendor. See CLAUDE.md and spec §9.';

const restrictedImports = (patterns) => ({
  'no-restricted-imports': [
    'error',
    { patterns: [{ group: patterns, message: BOUNDARY_MESSAGE }] },
  ],
});

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      'pnpm-lock.yaml',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      /* CLAUDE.md: no `any`. strictTypeChecked already enables the no-unsafe-* family;
         this makes the headline rule explicit so it cannot be quietly downgraded. */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      ...restrictedImports([...COMMS_SDKS, ...NON_COMMS_SDKS]),
    },
  },

  /* packages/providers is the containment boundary: everything is allowed here. */
  {
    files: ['packages/providers/**'],
    rules: { 'no-restricted-imports': 'off' },
  },

  /* packages/compliance may reach comms SDKs, but nothing else. */
  {
    files: ['packages/compliance/**'],
    rules: restrictedImports(NON_COMMS_SDKS),
  },

  /* Tests deliberately reference vendor module names as string literals when asserting the
     boundary; they never import them. Keep type-aware linting, relax test ergonomics. */
  {
    files: ['**/*.test.ts', '**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  /* Plain JS/MJS config files have no type information to lint against. */
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
);
