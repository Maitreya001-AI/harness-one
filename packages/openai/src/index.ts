/**
 * @harness-one/openai — OpenAI SDK adapter for harness-one.
 *
 * Provides a full AgentAdapter implementation backed by the OpenAI SDK,
 * with support for chat, streaming, and tool_calls handling.
 *
 * Works with any OpenAI-compatible API (Groq, DeepSeek, Together, Fireworks,
 * Perplexity, Mistral, Ollama, vLLM, LM Studio, etc.) via the baseURL option.
 *
 * @module
 */

import OpenAI from 'openai';
import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
  Message,
  TokenUsage,
  ToolSchema,
} from 'harness-one/core';
import { HarnessError, HarnessErrorCode} from 'harness-one/core';
import type { Logger } from 'harness-one/observe';
import { safeWarn, createDefaultLogger } from 'harness-one/observe';

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
 * Keys that `LLMConfig.extra` may carry into the OpenAI Chat Completions API.
 *
 * Only parameters that are (a) documented in the OpenAI Chat Completions spec
 * and (b) safe-by-default (no auth, no routing, no callback URLs) are listed.
 * Unknown keys are filtered with a single warn by default; pass
 * `strictExtraAllowList: true` to the adapter to turn the filter into a hard
 * `ADAPTER_INVALID_EXTRA` failure — useful for prod builds that want any
 * provider-drift to surface as a test/CI failure.
 *
 * This list mirrors the symmetry with the Anthropic adapter's filter (T05) and
 * is intentionally narrower than the OpenAI SDK surface: callers needing
 * provider-specific knobs beyond this list should open a PR to expand it
 * (preferred) or supply a pre-configured `client` that embeds the knob.
 */
const OPENAI_EXTRA_ALLOW_LIST: ReadonlySet<string> = new Set([
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'seed',
  'response_format',
  'user',
  'service_tier',
  'parallel_tool_calls',
]);

/**
 * Filter a caller-supplied `LLMConfig.extra` payload against the OpenAI
 * allow-list.
 *
 * Behaviour:
 *  - Undefined / empty input → returns `{}` with no warning.
 *  - All keys allow-listed → returns the payload verbatim, no warning.
 *  - Some unknown keys, `strict` = false → returns the filtered subset and
 *    emits a single warn listing the rejected keys.
 *  - Any unknown key, `strict` = true → throws `HarnessError` with code
 *    `ADAPTER_INVALID_EXTRA`; nothing is forwarded.
 *
 * Kept package-local (not reused from anthropic) so each adapter owns its own
 * allow-list surface and can evolve independently.
 */
function filterExtra(
  extra: Readonly<Record<string, unknown>> | undefined,
  strict: boolean,
  logger: Pick<Logger, 'warn' | 'error'> | undefined,
): Record<string, unknown> {
  if (extra === undefined) return {};

  const accepted: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const key of Object.keys(extra)) {
    if (OPENAI_EXTRA_ALLOW_LIST.has(key)) {
      accepted[key] = extra[key];
    } else {
      rejected.push(key);
    }
  }

  if (rejected.length === 0) return accepted;

  if (strict) {
    throw new HarnessError(
      `OpenAI adapter: LLMConfig.extra contained keys not in the allow-list: ${rejected.join(', ')}`,
      HarnessErrorCode.ADAPTER_INVALID_EXTRA,
      'Remove the offending keys, add them to OPENAI_EXTRA_ALLOW_LIST via a PR, or disable strictExtraAllowList.',
    );
  }

  const msg = `[harness-one/openai] LLMConfig.extra contained keys not in the allow-list and was filtered: ${rejected.join(', ')}. Pass strictExtraAllowList: true to fail instead of filtering.`;
  const meta = { rejectedKeys: rejected };
  if (logger !== undefined) {
    // A caller-supplied logger (even the Pick<> narrow one used by this
    // adapter) routes the warn itself; we only fall back to `safeWarn`'s
    // default redaction-enabled logger when none is provided.
    logger.warn(msg, meta);
  } else {
    safeWarn(undefined, msg, meta);
  }
  return accepted;
}

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
 * still be consumed by {@link createOpenAIAdapter} — seal only blocks *new*
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

/** Configuration for the OpenAI adapter. */
export interface OpenAIAdapterConfig {
  /** A pre-configured OpenAI client instance. Takes precedence over apiKey/baseURL. */
  readonly client?: OpenAI;
  /** API key. Defaults to OPENAI_API_KEY env var. Used when client is not provided. */
  readonly apiKey?: string;
  /** Base URL for OpenAI-compatible APIs (e.g. Groq, DeepSeek). Used when client is not provided. */
  readonly baseURL?: string;
  /** Default HTTP headers. Used when client is not provided. */
  readonly defaultHeaders?: Record<string, string>;
  /** Model name. Defaults to 'gpt-4o'. */
  readonly model?: string;
  /**
   * Maximum number of retries for transient errors (429, 5xx).
   * Passed to the OpenAI SDK client at creation time. Defaults to 2 (SDK default).
   */
  readonly maxRetries?: number;
  /**
   * Optional logger used for non-fatal adapter warnings (e.g. missing token
   * usage in a stream chunk, malformed tool arguments). Defaults to the
   * global `console` if not provided. Library code SHOULD NOT write directly
   * to `console` — accept a logger so hosts can route/silence warnings.
   */
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
  /**
   * When true, any key in `LLMConfig.extra` that is not in the adapter's
   * allow-list raises `HarnessError { code: HarnessErrorCode.ADAPTER_INVALID_EXTRA }` instead
   * of being silently filtered-with-warn. Intended for prod builds that want
   * provider-parameter drift to fail loudly in CI. Defaults to `false`.
   */
  readonly strictExtraAllowList?: boolean;
  /**
   * Optional token counting function. When provided, `countTokens()` delegates
   * to this function instead of the built-in heuristic. Useful for injecting
   * a tiktoken-based counter without coupling the adapter to the tokenizer package.
   */
  readonly countTokens?: (text: string) => number;
}

/** Convert a harness-one Message to OpenAI's chat completion message format. */
function toOpenAIMessage(
  msg: Message,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (msg.role === 'tool' && msg.toolCallId) {
    return {
      role: 'tool',
      tool_call_id: msg.toolCallId,
      content: msg.content,
    };
  }

  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: msg.content || '',
      tool_calls: msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      })),
    };
  }

  if (msg.role === 'system') {
    return { role: 'system', content: msg.content };
  }

  if (msg.role === 'assistant') {
    return { role: 'assistant', content: msg.content };
  }

  return { role: 'user', content: msg.content };
}

/**
 * Known keys on the harness-one JsonSchema subset that we forward to OpenAI.
 * Keys outside this set are silently dropped by `toOpenAIParameters`; Wave-12
 * P2-19 adds a one-shot warn per unknown key so schema drift is observable
 * without spamming per call-site.
 */
const _OPENAI_KNOWN_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'description',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'additionalProperties',
  'oneOf',
  'anyOf',
  'allOf',
  'const',
  'format',
]);

/**
 * Module-scoped dedupe for unknown-schema-key warnings (Wave-12 P2-19).
 * Bounded FIFO at 256 entries so long-running servers with drifting schemas
 * don't grow unbounded.
 */
const _unknownSchemaKeyWarned: Set<string> = new Set();
const _UNKNOWN_SCHEMA_KEY_WARN_CAP = 256;

/**
 * Module-scoped memoization for `toOpenAIParameters` (Wave-12 P1-21).
 *
 * Consumers typically pass the same schema object through every adapter
 * invocation; WeakMap-keyed memoization makes subsequent calls O(1) and avoids
 * the allocation on every `chat()` / `stream()` request. The WeakMap ensures
 * entries are GC'd with the schema.
 */
const _parametersMemo: WeakMap<object, Record<string, unknown>> = new WeakMap();

/**
 * Convert a harness-one JsonSchema to OpenAI's FunctionParameters
 * (`Record<string, unknown>`).
 *
 * OpenAI expects `Record<string, unknown>` for tool parameters. Rather than
 * using a double assertion (`as unknown as Record<string, unknown>`) we
 * explicitly map the known JsonSchema fields to produce a clean record.
 *
 * Wave-12:
 *  - P1-21: memoized via a WeakMap keyed on the schema object; identical
 *    schema references resolve to the same output reference.
 *  - P2-19: warn-once per unknown key so silently-dropped schema drift becomes
 *    observable.
 *
 * @internal
 */
function toOpenAIParameters(
  schema: ToolSchema['parameters'],
  logger?: Pick<Logger, 'warn' | 'error'>,
): Record<string, unknown> {
  // WeakMap keys must be objects; JsonSchema is always an object at runtime.
  const cached = _parametersMemo.get(schema as unknown as object);
  if (cached !== undefined) return cached;

  const result: Record<string, unknown> = { type: schema.type };
  if (schema.properties !== undefined) result.properties = schema.properties;
  if (schema.required !== undefined) result.required = schema.required;
  if (schema.items !== undefined) result.items = schema.items;
  if (schema.enum !== undefined) result.enum = schema.enum;
  if (schema.description !== undefined) result.description = schema.description;
  if (schema.default !== undefined) result.default = schema.default;
  if (schema.minimum !== undefined) result.minimum = schema.minimum;
  if (schema.maximum !== undefined) result.maximum = schema.maximum;
  if (schema.minLength !== undefined) result.minLength = schema.minLength;
  if (schema.maxLength !== undefined) result.maxLength = schema.maxLength;
  if (schema.pattern !== undefined) result.pattern = schema.pattern;
  if (schema.additionalProperties !== undefined) result.additionalProperties = schema.additionalProperties;
  if (schema.oneOf !== undefined) result.oneOf = schema.oneOf;
  if (schema.anyOf !== undefined) result.anyOf = schema.anyOf;
  if (schema.allOf !== undefined) result.allOf = schema.allOf;
  if (schema.const !== undefined) result.const = schema.const;
  if (schema.format !== undefined) result.format = schema.format;

  // P2-19: warn once per distinct unknown key. The cast to `Record<string, unknown>`
  // is safe — JsonSchema is a plain object; we only iterate its own keys.
  const dropped: string[] = [];
  for (const key of Object.keys(schema as unknown as Record<string, unknown>)) {
    if (!_OPENAI_KNOWN_SCHEMA_KEYS.has(key) && !_unknownSchemaKeyWarned.has(key)) {
      if (_unknownSchemaKeyWarned.size < _UNKNOWN_SCHEMA_KEY_WARN_CAP) {
        _unknownSchemaKeyWarned.add(key);
      }
      dropped.push(key);
    }
  }
  if (dropped.length > 0 && logger !== undefined) {
    logger.warn(
      `[harness-one/openai] toOpenAIParameters: dropped unknown schema key(s): ${dropped.join(', ')}. ` +
      'Only keys in the OpenAI adapter\'s known-schema set are forwarded; unknown keys are silently dropped. ' +
      '(Each distinct key warns at most once.)',
      { droppedKeys: dropped },
    );
  }

  _parametersMemo.set(schema as unknown as object, result);
  return result;
}

/**
 * Convert a harness-one ToolSchema to OpenAI's tool format.
 *
 * @internal
 */
function toOpenAITool(
  tool: ToolSchema,
  logger?: Pick<Logger, 'warn' | 'error'>,
): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toOpenAIParameters(tool.parameters, logger),
    },
  };
}

/**
 * Map OpenAI's usage to harness-one's TokenUsage.
 *
 * OpenAI exposes prompt-cache hits via the optional
 * `usage.prompt_tokens_details.cached_tokens` field (the newer Responses /
 * Chat Completions API shape). When present, we surface it as
 * `cacheReadTokens` so cost tracking in the core reflects cached-read savings.
 */
function toTokenUsage(
  usage: OpenAI.Completions.CompletionUsage | undefined,
): TokenUsage {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
  const base: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } = {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
  if (typeof cachedTokens === 'number') {
    base.cacheReadTokens = cachedTokens;
  }
  return base;
}

/** Parse an OpenAI response choice into a harness-one Message. */
function toHarnessMessage(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice,
): Message {
  const msg = choice.message;
  const toolCalls = msg.tool_calls?.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));

  return {
    role: 'assistant',
    content: msg.content ?? '',
    ...(toolCalls && toolCalls.length > 0 && { toolCalls }),
  };
}

/**
 * Wave-13 G-1 (P0-3): per-instance zero-usage warn-once dedupe.
 *
 * Prior to Wave-13 this was a single module-scoped `Set` shared by every
 * adapter instance in the process. In multi-tenant deployments that meant
 * tenant A's warning silenced tenant B's alert for the same model name — an
 * observability hole that made cost-tracking drift between tenants invisible.
 *
 * The factory below creates a fresh bounded LRU set per `createOpenAIAdapter`
 * call, sized at `_ZERO_USAGE_WARN_CAP` (1000 — larger than before because the
 * dedupe is no longer shared, so per-instance models accumulate more slowly).
 */
const _ZERO_USAGE_WARN_CAP = 1_000;

interface InstanceWarnedState {
  has(model: string): boolean;
  record(model: string): void;
}

function createInstanceWarnedState(cap = _ZERO_USAGE_WARN_CAP): InstanceWarnedState {
  const warned = new Set<string>();
  return {
    has(model: string): boolean {
      return warned.has(model);
    },
    record(model: string): void {
      if (warned.has(model)) return;
      if (warned.size >= cap) {
        // LRU behavior: evict oldest insertion when at capacity.
        const oldest = warned.values().next().value;
        if (oldest !== undefined) warned.delete(oldest);
      }
      warned.add(model);
    },
  };
}

/**
 * Wave-13 G-1: module-scoped fallback maintained only for backwards
 * compatibility with `_resetOpenAIWarnState()` tests that exercised the
 * legacy global dedupe. New adapter instances use `createInstanceWarnedState`
 * inside the factory closure instead, so cross-tenant contamination is
 * eliminated. This set is intentionally never written to by production code
 * paths in Wave-13+ — only `_resetOpenAIWarnState` clears it for test-parity
 * on the legacy surface. Marked for removal in a future breaking wave.
 *
 * @deprecated Use the per-instance warned state seeded inside
 * `createOpenAIAdapter()`. Retained only so `_resetOpenAIWarnState()` keeps
 * its signature for existing tests.
 */
const _globalZeroUsageWarnedModelsDeprecated: Set<string> = new Set();

/**
 * Wave-12 P0-2: guarded narrow on the OpenAI SDK stream's private
 * `controller` field.
 *
 * The SDK exposes its underlying `AbortController`-like object via a
 * `controller` property on the stream instance. Reaching for it used to be
 * done with a pair of `as unknown as T` casts, which silently type-launders
 * any shape the SDK might ship in a future minor — a refactor that could
 * turn into a runtime `TypeError` on the very next `.abort()` call.
 *
 * This helper instead probes the runtime shape step-by-step and returns
 * `undefined` whenever the expected structure isn't present. No raw
 * `as unknown as T` is used in the cleanup path.
 */
function getStreamController(s: unknown): { abort?: () => void } | undefined {
  if (typeof s !== 'object' || s === null) return undefined;
  const c = (s as Record<string, unknown>).controller;
  if (typeof c !== 'object' || c === null) return undefined;
  return c as { abort?: () => void };
}

/**
 * Create an AgentAdapter backed by the OpenAI SDK.
 *
 * Supports chat(), stream(), and tool_calls handling.
 */
export function createOpenAIAdapter(config: OpenAIAdapterConfig): AgentAdapter {
  const client: OpenAI = config.client ?? new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.defaultHeaders,
    maxRetries: config.maxRetries,
  });
  const model = config.model ?? 'gpt-4o';
  const strictExtra = config.strictExtraAllowList === true;
  // Wave-5F T12: delegate default logger to core's redaction-enabled
  // singleton instead of a hand-rolled console.warn/error fallback.
  const logger: Pick<Logger, 'warn' | 'error'> = config.logger ?? createDefaultLogger();
  const tokenizer = config.countTokens;
  // Wave-13 G-1 (P0-3): per-instance zero-usage warned-models LRU. Scoped
  // to this adapter instance so a single tenant's "rare model" warn does
  // not silence every other tenant's first-touch alert for the same model.
  const zeroUsageWarned = createInstanceWarnedState();

  return {
    name: `openai:${model}`,
    async chat(params: ChatParams): Promise<ChatResponse> {
      const response = await client.chat.completions.create({
        model,
        messages: params.messages.map(toOpenAIMessage),
        ...(params.tools && { tools: params.tools.map((t) => toOpenAITool(t, logger)) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.maxTokens !== undefined && { max_tokens: params.config.maxTokens }),
        ...(params.config?.stopSequences !== undefined && { stop: params.config.stopSequences as string[] }),
        ...(params.responseFormat?.type === 'json_object' && { response_format: { type: 'json_object' as const } }),
        ...(params.responseFormat?.type === 'json_schema' && {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: 'response',
              schema: toOpenAIParameters(params.responseFormat.schema, logger),
              ...(params.responseFormat.strict !== undefined && { strict: params.responseFormat.strict }),
            },
          },
        }),
        // Spec: LLMConfig.extra MUST be forwarded to the provider. Merge LAST
        // so caller-supplied unknown keys win over base params (per provider-spec.md).
        // T06: filtered against OPENAI_EXTRA_ALLOW_LIST; unknown keys are
        // dropped-with-warn, or raise ADAPTER_INVALID_EXTRA under strictExtra.
        ...filterExtra(params.config?.extra, strictExtra, logger),
      }, { signal: params.signal });

      const choice = response.choices[0];
      if (!choice) {
        throw new HarnessError('OpenAI returned no choices', HarnessErrorCode.ADAPTER_ERROR, 'Check if the model and API key are valid');
      }

      // SPEC-015: warn once per model when non-stream usage data is missing.
      // Wave-13 G-1: dedupe is scoped to this adapter instance via
      // `zeroUsageWarned`, not to the whole module.
      const usage = response.usage;
      const missingInput = usage?.prompt_tokens === undefined || usage?.prompt_tokens === null;
      const missingOutput = usage?.completion_tokens === undefined || usage?.completion_tokens === null;
      if ((missingInput || missingOutput) && !zeroUsageWarned.has(model)) {
        // Wave-12 P2-9: guard the warn metadata behind an optional
        // `isWarnEnabled()` gate when the host logger exposes one. The Logger
        // base type in `@harness-one/core/observe` does not define it today
        // so we probe defensively with `typeof === 'function'`.
        const maybeGate = (logger as { isWarnEnabled?: () => boolean }).isWarnEnabled;
        const warnEnabled = typeof maybeGate === 'function' ? maybeGate.call(logger) : true;
        if (warnEnabled) {
          zeroUsageWarned.record(model);
          logger.warn(
            `[harness-one/openai] chat() response for model "${model}" had missing prompt/completion token counts — cost tracking will under-report. (This warning is emitted once per model per adapter instance.)`,
          );
        }
      }

      return {
        message: toHarnessMessage(choice),
        usage: toTokenUsage(usage),
      };
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const stream = await client.chat.completions.create({
        model,
        messages: params.messages.map(toOpenAIMessage),
        ...(params.tools && { tools: params.tools.map((t) => toOpenAITool(t, logger)) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.maxTokens !== undefined && { max_tokens: params.config.maxTokens }),
        ...(params.config?.stopSequences !== undefined && { stop: params.config.stopSequences as string[] }),
        ...(params.responseFormat?.type === 'json_object' && { response_format: { type: 'json_object' as const } }),
        ...(params.responseFormat?.type === 'json_schema' && {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: 'response',
              schema: toOpenAIParameters(params.responseFormat.schema, logger),
              ...(params.responseFormat.strict !== undefined && { strict: params.responseFormat.strict }),
            },
          },
        }),
        stream: true,
        stream_options: { include_usage: true },
        // Spec: LLMConfig.extra MUST be forwarded to the provider. Merge LAST
        // so caller-supplied unknown keys win over base params.
        // T06: filtered against OPENAI_EXTRA_ALLOW_LIST; unknown keys are
        // dropped-with-warn, or raise ADAPTER_INVALID_EXTRA under strictExtra.
        ...filterExtra(params.config?.extra, strictExtra, logger),
      }, { signal: params.signal });

      const toolCallAccum = new Map<
        string,
        { id: string; name: string; arguments: string }
      >();
      // Secondary map: index -> ID, so continuation chunks without an id field
      // can be resolved to the correct accumulator entry via their positional index.
      const indexToId = new Map<number, string>();

      // Safety limits to prevent OOM from malformed streams
      const MAX_TOOL_CALLS = 128;
      const MAX_TOOL_ARG_BYTES = 1_048_576; // 1MB

      try {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            yield { type: 'text_delta', text: delta.content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              // Determine the lookup key: prefer tc.id, fall back to index-to-ID map,
              // and finally generate a fallback ID from the index.
              const id = tc.id ?? indexToId.get(tc.index) ?? `tool_${tc.index}`;

              // Skip new tool calls beyond the safety limit
              if (toolCallAccum.size >= MAX_TOOL_CALLS && !toolCallAccum.has(id)) {
                continue;
              }

              let accum = toolCallAccum.get(id);
              if (!accum) {
                accum = { id, name: '', arguments: '' };
                toolCallAccum.set(id, accum);
              }
              // Update the index-to-ID mapping whenever we see an id for an index
              if (tc.id) {
                indexToId.set(tc.index, tc.id);
                accum.id = tc.id;
              }
              if (tc.function?.name) accum.name = tc.function.name;
              if (tc.function?.arguments) {
                // Skip arguments that would exceed the size limit
                if (accum.arguments.length + tc.function.arguments.length > MAX_TOOL_ARG_BYTES) {
                  continue;
                }
                accum.arguments += tc.function.arguments;
              }

              yield {
                type: 'tool_call_delta',
                toolCall: {
                  ...(accum.id ? { id: accum.id } : {}),
                  ...(accum.name ? { name: accum.name } : {}),
                  ...(tc.function?.arguments !== undefined && { arguments: tc.function.arguments }),
                },
              };
            }
          }

          // OpenAI sends usage data in the final stream chunk.
          // We emit 'done' and return immediately upon receiving it.
          // If OpenAI changes this behavior (e.g., sends usage before final chunk),
          // subsequent chunks would be silently dropped — review this logic if that happens.
          if (chunk.usage) {
            yield { type: 'done', usage: toTokenUsage(chunk.usage) };
            return; // usage chunk is the final event — don't emit another done
          }
        }

        // Only emit bare done if stream ended without a usage chunk.
        // OBS-011: Emit both a warning and a tagged event so cost tracking can
        // detect this condition. Ensure stream_options.include_usage is set to
        // true in the request to guarantee usage data in the final chunk.
        logger.warn(
          '[harness-one/openai] Stream ended without usage data — token counts will be zero. ' +
          'Ensure stream_options.include_usage is true. This affects cost tracking and budget enforcement.',
        );
        yield {
          type: 'done' as const,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      } finally {
        // Ensure underlying stream resources are released on early consumer return.
        // The OpenAI SDK stream exposes a controller that can be aborted to free
        // the HTTP connection when the consumer breaks out of the async iterator.
        //
        // Wave-12 P0-2: replace the previous double-`as unknown as` casts with a
        // guarded narrow (`getStreamController`) so SDK drift — e.g. a rename,
        // removal, or type change of the private `controller` field — surfaces
        // as a safe no-op rather than a silent type-lie that would explode at
        // runtime the next time we dereference it.
        try {
          const ctrl = getStreamController(stream);
          if (ctrl && typeof ctrl.abort === 'function') {
            ctrl.abort();
          }
        } catch {
          // Stream controller cleanup failed — HTTP connection may linger until server timeout.
          // This is non-fatal; the GC will eventually collect the stream.
        }
      }
    },

    async countTokens(messages: readonly Message[]): Promise<number> {
      const text = messages.map((m) => m.content).join('');
      if (tokenizer) return tokenizer(text);
      // Heuristic: ~4 chars per token + small overhead per message for role/framing
      return Math.ceil(text.length / 4) + messages.length * 4;
    },
  };
}

/**
 * Test-only: reset the module-scoped "zero-usage warn once" dedupe sets.
 *
 * Library consumers should NOT need to call this. It exists so unit tests can
 * exercise the one-time-warn behaviour across multiple `it()` cases without
 * leaking state between tests.
 *
 * Wave-12 extends this to also clear the `toOpenAIParameters` unknown-key
 * warn-once dedupe (P2-19) so schema-drift tests stay hermetic.
 *
 * @internal
 */
export function _resetOpenAIWarnState(): void {
  // Wave-13 G-1: per-instance warned state is no longer reachable from outside
  // the factory closure, so this helper only clears the module-scoped caches
  // that still exist (the unknown-schema-key dedupe + the deprecated global
  // zero-usage set retained for legacy test parity). Tests that need to
  // re-exercise per-instance dedupe behaviour should create a fresh adapter.
  _globalZeroUsageWarnedModelsDeprecated.clear();
  _unknownSchemaKeyWarned.clear();
}
