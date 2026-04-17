import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import noTypeOnlyHarnessErrorCode from './tools/eslint-rules/no-type-only-harness-error-code.js';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/coverage/',
      '**/examples/',
      // Lint fixtures exist to be invalid — exclude from normal lint; run
      // manually with `--no-ignore` when verifying rule behavior.
      '**/__lint-fixtures__/',
    ],
  },
  ...tseslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      // Enforce explicit return types on exported functions for API clarity
      '@typescript-eslint/explicit-function-return-type': ['warn', {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
        allowHigherOrderFunctions: true,
      }],
      // Prevent accidental floating promises — requires typed linting
      // (parserOptions.project). Kept 'off' at the global level; enable in
      // package-level configs that wire up project references. The rule is
      // documented as a code-review standard even when not lint-enforced.
      '@typescript-eslint/no-floating-promises': 'off',
      // Allow unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // Consistent type imports (warn only to avoid breaking dynamic import() patterns)
      '@typescript-eslint/consistent-type-imports': 'off',
      // Allow overload signatures (common in event emitter patterns)
      '@typescript-eslint/unified-signatures': 'off',
      // Disallow non-null assertions (prefer explicit checks)
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Allow empty functions for stubs and callbacks
      '@typescript-eslint/no-empty-function': 'off',
      // Allow dynamic delete for Map-like patterns
      '@typescript-eslint/no-dynamic-delete': 'off',
      // Allow extraneous class for patterns used in the codebase
      '@typescript-eslint/no-extraneous-class': 'off',
      // Allow non-null assertions in tests
      '@typescript-eslint/no-invalid-void-type': 'off',
      // Disallow console in library source code (use structured logging)
      'no-console': ['warn', { allow: ['warn', 'debug'] }],
    },
  },
  // Wave-5C F-2 / ADR §3.e: forbid reaching into harness-one's infra/
  // internals from outside packages/core/src/. Tests inside packages/core
  // are allowed to import infra (they own it); other packages must go
  // through the public subpaths.
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    ignores: [
      'packages/core/src/**',
      '**/__tests__/**',
      '**/*.test.ts',
      '**/__lint-fixtures__/**',
    ],
    plugins: {
      import: importPlugin,
    },
    rules: {
      'import/no-internal-modules': ['error', {
        forbid: [
          'harness-one/infra',
          'harness-one/infra/**',
          'harness-one/dist/infra',
          'harness-one/dist/infra/**',
          // Wave-14 ARCHITECTURE.md: sibling packages must go through the
          // published subpath exports, not through the source tree. These
          // patterns catch mistyped imports like `harness-one/src/core/...`.
          'harness-one/src',
          'harness-one/src/**',
          'harness-one/dist/src',
          'harness-one/dist/src/**',
        ],
      }],
    },
  },
  // Wave-15 ARCHITECTURE.md: layering contract. `core/src/infra/**` sits
  // at L1 and must not import from any higher layer — including L2
  // (`core/core/**`). Error primitives (`errors-base.ts`) and branded-id
  // types (`brands.ts`) now live inside infra itself, so the Wave-14
  // carve-out for `core/errors.js` / `core/types.js` is no longer needed.
  {
    files: ['packages/core/src/infra/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              '../core/**',
              '../orchestration/**',
              '../session/**',
              '../observe/**',
              '../guardrails/**',
              '../memory/**',
              '../tools/**',
              '../prompt/**',
              '../context/**',
              '../rag/**',
              '../evolve-check/**',
              '../redact/**',
            ],
            message: 'infra is the bottom layer (L1). It must not import from any higher layer. See docs/ARCHITECTURE.md.',
          },
        ],
      }],
    },
  },
  // Wave-5C PR-3 T-3.3: HarnessErrorCode must be a value import (it is a
  // string enum with runtime introspection — `import type` silently breaks
  // Object.values(). ADR §3.f + §7 PR-3 step 4.
  {
    files: ['packages/**/*.{ts,tsx}'],
    plugins: {
      'harness-one': {
        rules: {
          'no-type-only-harness-error-code': noTypeOnlyHarnessErrorCode,
        },
      },
    },
    rules: {
      'harness-one/no-type-only-harness-error-code': 'error',
    },
  },
  // Relax rules for test files
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  // Relax no-console for CLI code which intentionally uses console
  {
    files: ['**/cli/**/*.ts', '**/cli.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
