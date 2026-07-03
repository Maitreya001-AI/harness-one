/**
 * Synchronous lazy-loader for the preset's optional peer packages.
 *
 * The preset's public factories ({@link createHarness} / {@link createSecurePreset})
 * are **synchronous**, and must stay that way — consumers construct a harness
 * with `const h = createHarness(...)`, not `await`. To keep them synchronous
 * while loading provider adapters (`@harness-one/anthropic`,
 * `@harness-one/openai`) and the dev-time eval toolkit (`@harness-one/devkit`)
 * only on demand, we resolve those packages with a `createRequire`-backed lazy
 * `require` rather than an async dynamic `import()`.
 *
 * Why `createRequire` and not `import()`:
 * - `import()` returns a Promise, which would force the public factories to
 *   become `async` — a breaking change for every caller.
 * - `createRequire(import.meta.url)` works in BOTH tsup outputs: the ESM build
 *   keeps `import.meta.url` verbatim; the CJS build has esbuild rewrite it to a
 *   `pathToFileURL(__filename)`-style expression. Every optional package ships a
 *   CJS entry (`require` export condition → `dist/index.cjs`), so `require()`
 *   resolves cleanly under both module systems.
 *
 * When a requested package is absent we surface an actionable
 * {@link HarnessError} naming the exact install command, so a missing peer never
 * degrades into an opaque `MODULE_NOT_FOUND` stack trace. Features that are
 * merely *nice to have* when present (e.g. sealing the OpenAI provider registry)
 * use {@link tryLoadOptional}, which returns `null` instead of throwing.
 *
 * @module
 */

import { createRequire } from 'node:module';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

/**
 * A `require` anchored at this module's own location so bare workspace
 * specifiers resolve through the preset package's `node_modules`.
 */
const nodeRequire = createRequire(import.meta.url);

/**
 * Attempt to load an optional peer package synchronously.
 *
 * Returns the module namespace on success, or `null` when the package (or one
 * of its own peer SDKs) cannot be loaded. Never throws — callers decide whether
 * absence is fatal. Use this for features that should silently no-op when the
 * package is not installed.
 */
export function tryLoadOptional<T>(pkg: string): T | null {
  try {
    return nodeRequire(pkg) as T;
  } catch {
    return null;
  }
}

/**
 * Load a peer package that is required for a feature the caller explicitly asked
 * for (e.g. selecting `provider: 'openai'`). On failure, throws an actionable
 * {@link HarnessError} naming the exact install command instead of a raw
 * `MODULE_NOT_FOUND`.
 *
 * @param pkg - The package specifier to load, e.g. `'@harness-one/openai'`.
 * @param opts.feature - Human-readable name of the feature that needs it, used
 *   in the error message (e.g. `"provider: 'openai'"`).
 * @param opts.install - The exact install command a user should run, e.g.
 *   `'npm install @harness-one/openai openai'`.
 */
export function requireForFeature<T>(
  pkg: string,
  opts: { readonly feature: string; readonly install: string },
): T {
  try {
    return nodeRequire(pkg) as T;
  } catch (err) {
    throw new HarnessError(
      `${opts.feature} needs the "${pkg}" package (and its peer SDK), which could not be loaded. `
        + `Install it with \`${opts.install}\`.`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      `Run \`${opts.install}\` to enable ${opts.feature}.`,
      err instanceof Error ? err : undefined,
    );
  }
}
