/**
 * Lint fixture — expected to FAIL `harness-one/no-type-only-harness-error-code`.
 *
 * Kept out of the main lint run by the
 * `**​/__lint-fixtures__/**` ignore entry in `eslint.config.js`. Manual
 * verification: `pnpm eslint --no-ignore packages/openai/src/__lint-fixtures__/type-only-error-code.ts`
 * must emit one `harness-one/no-type-only-harness-error-code` error.
 */

// deno-lint-ignore-file
// @ts-nocheck
import type { HarnessErrorCode } from 'harness-one/core';

export function sample(code: HarnessErrorCode): void {
  void code;
}
