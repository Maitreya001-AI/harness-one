import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  {
    ignores: ['**/dist/', '**/node_modules/', '**/coverage/', '**/examples/'],
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
      // Prevent accidental floating promises
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
        ],
      }],
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
