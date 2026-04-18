/**
 * The `@harness-one/openai` package — provider registry.
 *
 * Owns the module-scoped registry of OpenAI-compatible provider base URLs
 * together with its controlled-mutation API: `registerProvider`,
 * `sealProviders`, `isProvidersSealed`, and the frozen `providers` Proxy.
 *
 * This file is intentionally self-contained — it does not depend on the
 * adapter factory or on any conversion helper. It is imported by
 * `src/index.ts` and re-exported unchanged as part of the public surface.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import { safeWarn } from 'harness-one/observe';

const _providers: Record<string, { baseURL: string }> = {
  openrouter: { baseURL: 'https://openrouter.ai/api/v1' },
  groq: { baseURL: 'https://api.groq.com/openai/v1' },
  deepseek: { baseURL: 'https://api.deepseek.com' },
  together: { baseURL: 'https://api.together.xyz/v1' },
  fireworks: { baseURL: 'https://api.fireworks.ai/inference/v1' },
  perplexity: { baseURL: 'https://api.perplexity.ai' },
  mistral: { baseURL: 'https://api.mistral.ai/v1' },
  ollama: { baseURL: 'http://localhost:11434/v1' },
};

/**
 * Wave-12 P2-11: reentrancy guard for {@link registerProvider} /
 * {@link sealProviders}.
 *
 * These mutators must be called serially from a single init path. A simple
 * boolean flag is enough because both paths are synchronous — if we observe
 * the flag as `true` during our own synchronous section it means another
 * caller (e.g. on a different worker or through re-entrant code) raced us.
 */
let _registryMutationInFlight = false;

/**
 * Module-private flag tracking whether {@link sealProviders} has been called.
 *
 * Kept behind the accessor pair `sealProviders()` / `isProvidersSealed()` so
 * callers cannot mutate the flag directly (no exported mutable reference).
 *
 * Lifetime note: this flag is a *module singleton*. It is shared across every
 * import of this module within one JS realm, but it does NOT cross
 * `worker_threads`, child processes, or `vi.resetModules()` boundaries — each
 * fresh module instance starts unsealed. Tests that need a clean slate should
 * call `vi.resetModules()` (see `seal-providers.test.ts`).
 */
let _providersSealed = false;

/** Names reserved for built-in adapters; cannot be overridden without force. */
const BUILT_IN_PROVIDER_NAMES: ReadonlySet<string> = new Set(['openai', 'anthropic']);

/**
 * Well-known OpenAI-compatible provider base URLs.
 *
 * Usage:
 *   createOpenAIAdapter({ ...providers.groq, apiKey: '...', model: 'llama-3.3-70b-versatile' })
 *
 * Wave-13 G-3: `providers` is a `Proxy` over the underlying `_providers`
 * record that (a) returns a frozen `{ baseURL }` view for every read so
 * callers cannot do `providers.groq.baseURL = 'https://evil.test'`, (b)
 * refuses any direct mutation (set / delete / defineProperty / setPrototypeOf
 * / preventExtensions changes) and (c) surfaces providers registered after
 * module-init through `registerProvider()` so the registration API keeps
 * working. This is a strictly tighter invariant than pre-Wave-13 where
 * `providers` was a plain `Readonly<Record<...>>` view — TypeScript accepted
 * the read-only marker but runtime mutation was silently allowed.
 */
function _deepFrozenEntry(entry: { baseURL: string } | undefined): Readonly<{ baseURL: string }> | undefined {
  if (entry === undefined) return undefined;
  // Return a fresh frozen object each time rather than freezing `_providers`
  // in place — that would break `registerProvider`'s in-place update.
  return Object.freeze({ baseURL: entry.baseURL });
}

export const providers: Readonly<Record<string, { readonly baseURL: string }>> = new Proxy(
  _providers as unknown as Readonly<Record<string, { readonly baseURL: string }>>,
  {
    get(target, prop: string | symbol): Readonly<{ baseURL: string }> | undefined {
      if (typeof prop !== 'string') return undefined;
      return _deepFrozenEntry((target as unknown as Record<string, { baseURL: string }>)[prop]);
    },
    set(): boolean {
      throw new TypeError(
        "Cannot assign to a property of the read-only 'providers' registry. Use registerProvider() to add entries.",
      );
    },
    defineProperty(): boolean {
      throw new TypeError(
        "Cannot define properties on the read-only 'providers' registry. Use registerProvider() to add entries.",
      );
    },
    deleteProperty(): boolean {
      throw new TypeError("Cannot delete properties from the read-only 'providers' registry.");
    },
    setPrototypeOf(): boolean {
      throw new TypeError("Cannot change prototype of the 'providers' registry.");
    },
    preventExtensions(): boolean {
      // Already effectively non-extensible via set/defineProperty traps.
      return true;
    },
    isExtensible(): boolean {
      return false;
    },
  },
);

/**
 * Register a custom OpenAI-compatible provider or override an existing one.
 *
 * SECURITY WARNING: This function mutates a module-scoped registry that
 * influences which base URL subsequent `createOpenAIAdapter({ ...providers.X })`
 * calls resolve to. It MUST only be called from trusted initialization code
 * (e.g. application bootstrap). Do NOT drive it from untrusted input (user
 * requests, config files fetched at runtime, etc.) — doing so would allow an
 * attacker to redirect API traffic (and bearer tokens) to an arbitrary host.
 *
 * CONCURRENCY CONTRACT (Wave-12 P2-11): `registerProvider()` and
 * `sealProviders()` MUST be called serially from a single initialization path.
 * Calling them concurrently — from multiple async tasks, worker threads, or
 * through reentrant code — throws a distinct `CORE_INVALID_CONFIG` error. The
 * implementation uses a simple module-scoped reentrancy flag; it is not a
 * mutex, so it only detects same-realm races and is a best-effort safeguard
 * against the footgun of racing bootstrap paths.
 *
 * Validation applied:
 *  - `config.baseURL` MUST parse as a valid URL (WHATWG `new URL`).
 *  - The scheme MUST be `https:` unless the host is `localhost` or
 *    `127.0.0.1` (for local-dev-only HTTP providers like Ollama / vLLM /
 *    LM Studio).
 *  - Built-in adapter names (`openai`, `anthropic`) are reserved. To
 *    deliberately override them, pass `{ force: true }` as the third argument.
 *  - Re-registering an existing non-built-in name with a DIFFERENT baseURL
 *    requires `{ allowOverride: true }` (Wave-12 P1-13). Idempotent
 *    re-registration (same baseURL) is a no-op with or without the flag.
 *
 * @throws {HarnessError} with code `INVALID_CONFIG` on any validation failure,
 *   `PROVIDER_REGISTRY_SEALED` if called after `sealProviders()`.
 */
/**
 * Options accepted by {@link registerProvider}.
 *
 * Wave-13 G-2: adds `trustedOrigins` so deployment bootstraps can pin the set
 * of hosts that are acceptable targets for custom provider registration. An
 * attacker who lands a second `registerProvider()` call with a hostile but
 * syntactically valid URL still fails fast because the origin is not on the
 * whitelist.
 */
export interface RegisterProviderOptions {
  readonly force?: boolean;
  readonly allowOverride?: boolean;
  /**
   * Wave-13 G-2: optional whitelist of acceptable `URL.origin` values
   * (scheme + host + port). When set and the parsed `baseURL.origin` is not
   * in the list, `registerProvider()` throws
   * `HarnessError(PROVIDER_REGISTRY_SEALED)` before mutating the registry.
   *
   * Matching is case-sensitive and exact — provide normalized origins, e.g.
   * `['https://api.groq.com', 'https://api.openai.com']`.
   */
  readonly trustedOrigins?: readonly string[];
}

export function registerProvider(
  name: keyof typeof providers,
): void;
export function registerProvider(
  name: string,
  config: { baseURL: string },
  options?: RegisterProviderOptions,
): void;
export function registerProvider(
  name: string,
  config?: { baseURL: string },
  options?: RegisterProviderOptions,
): void {
  // Wave-13 G-4: shorthand overload — `registerProvider('groq')` uses the
  // bundled `providers` const. Fails loudly if the name isn't bundled.
  if (config === undefined) {
    const bundled = _providers[name];
    if (bundled === undefined) {
      throw new HarnessError(
        `registerProvider: "${name}" is not a bundled provider; pass { baseURL } explicitly`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        `Known bundled providers: ${Object.keys(_providers).join(', ')}. Supply { baseURL } for custom providers.`,
      );
    }
    config = { baseURL: bundled.baseURL };
  }
  // Wave-12 P2-11: reentrancy guard. `registerProvider` / `sealProviders`
  // MUST be called serially from a single init path. If another caller is
  // mid-mutation when we enter, throw distinctly so the race surfaces.
  if (_registryMutationInFlight) {
    throw new HarnessError(
      'registerProvider: concurrent registry mutation detected — registerProvider()/sealProviders() must be called serially from a single init path',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Gate provider registration behind your bootstrap entry-point and avoid mutating the registry from multiple async tasks / workers.',
    );
  }
  _registryMutationInFlight = true;
  try {
    // Seal check runs FIRST, before any other validation. Rationale: once the
    // registry is sealed we want every registration attempt — valid or not — to
    // fail with the same distinct `PROVIDER_REGISTRY_SEALED` code, so production
    // alerting can key off a single signal. Running validation ahead of the
    // seal check would cause sealed-registry attempts with a typo in `name` or
    // `config.baseURL` to surface as `INVALID_CONFIG` instead, hiding the real
    // root cause.
    if (_providersSealed) {
      throw new HarnessError(
        `cannot register provider "${name}" — provider registry is sealed`,
        HarnessErrorCode.PROVIDER_REGISTRY_SEALED,
        'Call sealProviders() only after all providers are registered (typically at the end of bootstrap / inside createSecurePreset). Registering a new provider after seal requires restarting the process.',
      );
    }

    if (typeof name !== 'string' || name.length === 0) {
      throw new HarnessError(
        'registerProvider: name must be a non-empty string',
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Pass a non-empty provider name as the first argument.',
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(config.baseURL);
    } catch (err) {
      throw new HarnessError(
        `registerProvider: baseURL "${config.baseURL}" is not a valid URL`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Pass a fully qualified absolute URL (including scheme), e.g. "https://api.example.com/v1".',
        err instanceof Error ? err : undefined,
      );
    }

    const isLocalDev = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !isLocalDev) {
      throw new HarnessError(
        `registerProvider: refusing non-HTTPS baseURL "${config.baseURL}"`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Use an https:// URL. Plain http:// is only allowed for localhost / 127.0.0.1 development endpoints.',
      );
    }

    // Wave-13 G-2: enforce trusted-origins whitelist when the caller supplied
    // one. Rejected registrations use `PROVIDER_REGISTRY_SEALED` so ops can
    // alert on a single error code regardless of whether the origin was
    // rejected because the registry was sealed or because the whitelist
    // didn't include the parsed origin.
    if (options?.trustedOrigins !== undefined && options.trustedOrigins.length > 0) {
      if (!options.trustedOrigins.includes(parsed.origin)) {
        throw new HarnessError(
          `registerProvider: origin "${parsed.origin}" is not in trustedOrigins whitelist`,
          HarnessErrorCode.PROVIDER_REGISTRY_SEALED,
          `Add "${parsed.origin}" to trustedOrigins, or pick a baseURL whose origin matches one of: ${options.trustedOrigins.join(', ')}.`,
        );
      }
    }

    // L4: Warn on private network URLs that may indicate misconfiguration.
    // Not blocked because internal networks legitimately use private IPs,
    // but surfacing it helps catch copy-paste errors from dev configs.
    if (!isLocalDev) {
      const host = parsed.hostname;
      const isPrivate = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host);
      if (isPrivate) {
        safeWarn(undefined, `[harness-one/openai] registerProvider: baseURL "${config.baseURL}" points to a private IP range. Verify this is intentional for production use.`);
      }
    }

    if (BUILT_IN_PROVIDER_NAMES.has(name) && !options?.force) {
      throw new HarnessError(
        `registerProvider: "${name}" is a reserved built-in provider name`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Pick a different name, or pass { force: true } as the third argument to explicitly override the built-in.',
      );
    }

    // Wave-12 P1-13: silent overwrite is a security footgun (an attacker who
    // lands a second registerProvider() call could repoint a well-known
    // provider name to a hostile baseURL). Require callers to opt-in via
    // `allowOverride: true` (or `force: true`, which subsumes it for
    // built-ins) whenever the baseURL would change. Idempotent re-registration
    // with the same baseURL is still a no-op to keep bootstrap code simple.
    const existing = _providers[name];
    if (
      existing !== undefined &&
      existing.baseURL !== config.baseURL &&
      !options?.allowOverride &&
      !options?.force
    ) {
      throw new HarnessError(
        `registerProvider: "${name}" is already registered with a different baseURL ("${existing.baseURL}")`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Pass { allowOverride: true } to replace the existing baseURL, or pick a different provider name.',
      );
    }

    _providers[name] = { baseURL: config.baseURL };
  } finally {
    _registryMutationInFlight = false;
  }
}

/**
 * Seal the provider registry.
 *
 * After calling this, any subsequent {@link registerProvider} invocation
 * throws `HarnessError` with code `PROVIDER_REGISTRY_SEALED`. Already-
 * registered providers remain available through {@link providers} and can
 * still be consumed by `createOpenAIAdapter` — seal only blocks *new*
 * registrations.
 *
 * Idempotent: calling `sealProviders()` twice (or more) is a no-op; it never
 * throws and never mutates anything beyond the first call.
 *
 * Intended use:
 *  1. During application bootstrap, register every custom provider you need.
 *  2. Once bootstrap is complete (e.g. inside `createSecurePreset`), call
 *     `sealProviders()` so that later code paths — including tests, plugins,
 *     and request handlers — cannot redirect traffic by registering rogue
 *     providers.
 *
 * Scope note: the seal flag is a module singleton. It does NOT propagate
 * across `worker_threads`, forked child processes, or test runners that call
 * `vi.resetModules()`. Each fresh module instance starts unsealed.
 *
 * Concurrency (Wave-12 P2-11): like `registerProvider`, `sealProviders` must
 * be called serially from a single initialization path — racing it with
 * registerProvider throws `CORE_INVALID_CONFIG`.
 *
 * @see isProvidersSealed
 * @see registerProvider
 */
export function sealProviders(): void {
  // Wave-12 P2-11: reentrancy guard. sealProviders() must never race with
  // a concurrent registerProvider() call.
  if (_registryMutationInFlight) {
    throw new HarnessError(
      'sealProviders: concurrent registry mutation detected — registerProvider()/sealProviders() must be called serially from a single init path',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Gate provider registration behind your bootstrap entry-point and avoid mutating the registry from multiple async tasks / workers.',
    );
  }
  _registryMutationInFlight = true;
  try {
    _providersSealed = true;
  } finally {
    _registryMutationInFlight = false;
  }
}

/**
 * Return `true` if the provider registry has been sealed via
 * {@link sealProviders}, otherwise `false`.
 *
 * Useful in diagnostics/logging, in tests that assert seal state, and in
 * higher-level presets that want to avoid double-sealing or to branch on
 * whether bootstrap has completed.
 */
export function isProvidersSealed(): boolean {
  return _providersSealed;
}
