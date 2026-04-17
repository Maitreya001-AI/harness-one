/**
 * Structured logger for harness-one.
 *
 * Supports JSON and human-readable output, log levels,
 * and child loggers with inherited metadata.
 *
 * @module
 */

import {
  createRedactor,
  sanitizeAttributes,
  type RedactConfig,
  type Redactor,
} from '../infra/redact.js';

/** Supported log levels, ordered from most to least verbose. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured logger interface. */
export interface Logger {
  /**
   * P2-18: `meta` is accepted as `Readonly<Record<string, unknown>>`. Callers
   * are free to pass either a mutable or a frozen object — the logger never
   * mutates the caller's reference. Widening from `Record` to `Readonly` is a
   * backward-compatible signature change (a mutable record satisfies the
   * readonly constraint).
   */
  debug(message: string, meta?: Readonly<Record<string, unknown>>): void;
  info(message: string, meta?: Readonly<Record<string, unknown>>): void;
  warn(message: string, meta?: Readonly<Record<string, unknown>>): void;
  error(message: string, meta?: Readonly<Record<string, unknown>>): void;
  /** Create a child logger that inherits and extends base metadata. */
  child(meta: Readonly<Record<string, unknown>>): Logger;
  /**
   * Optional level gate consulted by hot-path callers (OpenAI + Anthropic
   * adapters) before allocating expensive meta payloads they'd otherwise
   * hand to `warn()`. The other levels don't ship a companion check because
   * no adapter currently gates on them — add the specific gate you need
   * when a real caller shows up.
   */
  isWarnEnabled?(): boolean;
}

/** Configuration for the logger factory. */
export interface LoggerConfig {
  /** Minimum log level. Default: 'info'. */
  readonly level?: LogLevel;
  /** Output as JSON lines. Default: false. */
  readonly json?: boolean;
  /** Custom output function. Default: console.log. */
  readonly output?: (line: string) => void;
  /**
   * SEC-001 + T02 (Wave-5A): Secret redaction configuration.
   *
   * Every metadata object passed through the logger is scrubbed before
   * serialization (API keys, tokens, passwords, cookies, etc.).
   *
   * Semantics (Wave-5, secure-by-default):
   *   - `undefined` (omitted)   → DEFAULT redactor is enabled
   *                               (equivalent to `{ useDefaultPattern: true }`).
   *   - `false`                 → Redaction is fully disabled. Metadata flows
   *                               through untouched. Prototype-pollution
   *                               protection is also skipped — this is an
   *                               intentional all-or-nothing escape hatch for
   *                               callers who have their own sanitization.
   *   - `RedactConfig` object   → Unchanged behavior: the config is passed
   *                               verbatim to `createRedactor`. `{}` still
   *                               activates the default pattern.
   *
   * Migration note from Wave-4: previously `undefined` meant "no redaction".
   * This is a breaking change in semantics: existing callers who relied on
   * zero redaction must now set `redact: false` explicitly.
   */
  readonly redact?: RedactConfig | false;
  /**
   * OBS-001: Correlation ID automatically injected into every log record
   * under the `correlationId` field. Useful for linking logs to a request or
   * trace. Propagates to child loggers via normal baseMeta merging.
   */
  readonly correlationId?: string;
  /**
   * P1-7: Per-call context hook invoked on every log emission to pull the
   * current trace/span id from an external async-context source (e.g.
   * AsyncLocalStorage, OpenTelemetry's `trace.getActiveSpan()`).
   *
   * The returned `traceId` / `spanId` are merged into the outgoing record as
   * `trace_id` and `span_id` (underscore-namespaced to avoid colliding with
   * the existing `correlationId` field and with caller-supplied meta). Caller
   * meta with those keys takes precedence — the hook never overwrites user
   * fields.
   *
   * The hook is called once per log call that passes the level gate. If it
   * throws or returns `undefined`, the record is emitted without trace/span
   * fields (fail-open: a broken context hook must not silence logs).
   */
  readonly getContext?: () => { traceId?: string; spanId?: string } | undefined;
  /**
   * P2-14: Stack-trace path sanitizer override. When set, absolute paths in
   * `Error.stack` output are rewritten to be relative to this prefix.
   * Default: `process.cwd()` when available.
   */
  readonly stackSanitizer?: { readonly cwd?: string; readonly disabled?: boolean };
}

/**
 * P2-14: Sanitize a stack trace by replacing absolute paths with relative
 * forms. Useful for redacting local filesystem layout and monorepo roots
 * before emitting to log aggregators.
 *
 * Rules:
 *   1. Strip the `cwd` prefix (plus the following separator) so paths become
 *      `packages/core/src/foo.ts:12:3` instead of
 *      `/Users/alice/proj/packages/core/src/foo.ts:12:3`.
 *   2. Collapse `.../node_modules/` segments to `node_modules/` so deeply
 *      nested monorepo roots like
 *      `/home/ci/build-abc/node_modules/pkg/...` become `node_modules/pkg/...`.
 *   3. Handle `file://` URL stack entries (V8, ESM) the same way.
 *
 * The function is deliberately forgiving — an unexpected stack format is
 * returned unchanged rather than throwing.
 */
export function sanitizeStackTrace(stack: string, opts?: { readonly cwd?: string }): string {
  if (typeof stack !== 'string' || stack.length === 0) return stack;
  const cwdRaw = opts?.cwd ?? (typeof process !== 'undefined' ? process.cwd() : '');
  let out = stack;
  // Strip cwd prefix (both bare path and file:// URL form).
  if (cwdRaw) {
    const escapedCwd = cwdRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cwdRegex = new RegExp(escapedCwd + '[\\/\\\\]', 'g');
    out = out.replace(cwdRegex, '');
    // file:// URL variant — Node ESM stacks look like `file:///abs/path/foo.ts:1:1`.
    const cwdUrlRegex = new RegExp('file://' + escapedCwd + '[\\/\\\\]', 'g');
    out = out.replace(cwdUrlRegex, '');
  }
  // Collapse any remaining `.../node_modules/` prefix to `node_modules/`.
  // Handles both POSIX (/path/to/node_modules/) and Windows
  // (\\path\\to\\node_modules\\) separators.
  out = out.replace(/[\/\\][^\s:()]*?[\/\\]node_modules[\/\\]/g, 'node_modules/');
  // Also strip a bare leading `file://` that no longer has an absolute path
  // behind it (e.g. stripped cwd leaves `file://packages/...`).
  out = out.replace(/file:\/\//g, '');
  return out;
}

const LOG_LEVEL_VALUES: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Custom JSON replacer that handles Error objects, Date objects, and
 * circular references for safe serialization of meta objects.
 *
 * - Error objects are serialized as `{ name, message, stack }`.
 * - Date objects are serialized as ISO 8601 strings.
 * - Circular references are replaced with the string `"[Circular]"`.
 *
 * PERF-030: The returned replacer carries per-call cycle-tracking state
 * (a WeakSet), so it MUST be constructed fresh for each `JSON.stringify`
 * invocation. The factory itself is stateless and hoisted to module scope.
 *
 * P2-14: Optional `sanitizeStack` callback rewrites `Error.stack` before
 * emission so absolute filesystem paths don't leak into log sinks.
 */
export function createSafeReplacer(opts?: {
  readonly sanitizeStack?: (stack: string) => string;
}): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  const sanitizeStack = opts?.sanitizeStack;
  // Wave-13 C-9: Recursive helper that materialises an Error (plus its
  // `cause` chain) into a plain `{ name, message, stack, cause? }` envelope
  // with stack sanitisation applied at every level. A cycle guard prevents
  // infinite recursion if `cause` forms a loop (rare but observed in the
  // wild).
  const MAX_CAUSE_DEPTH = 8;
  function renderError(err: Error, depth: number, visited: WeakSet<Error>): Record<string, unknown> {
    if (visited.has(err)) {
      return { name: err.name, message: '[Circular]' };
    }
    visited.add(err);
    const rawStack = err.stack;
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };
    if (typeof rawStack === 'string') {
      out.stack = sanitizeStack ? sanitizeStack(rawStack) : rawStack;
    }
    const rawCause = (err as Error & { cause?: unknown }).cause;
    if (rawCause !== undefined && depth < MAX_CAUSE_DEPTH) {
      if (rawCause instanceof Error) {
        out.cause = renderError(rawCause, depth + 1, visited);
      } else {
        // Non-Error causes still get stack sanitisation if they expose a
        // `stack` string (common in abuse-of-cause callers).
        out.cause = rawCause;
      }
    } else if (rawCause !== undefined) {
      out.cause = '[MaxCauseDepthExceeded]';
    }
    return out;
  }

  return (key: string, value: unknown): unknown => {
    // P2-14: Apply the stack sanitizer whenever we emit a `stack` string
    // field — not just when the value is an Error. The upstream redactor
    // (`sanitizeAttributes`) pre-serializes Error instances into plain
    // `{ name, message, stack }` objects before our replacer runs, so by
    // the time we see the `stack` key the Error-ness is already lost.
    // Gating on `key === 'stack'` + `typeof value === 'string'` is cheap
    // and covers both paths (raw Error + pre-serialized object).
    if (sanitizeStack && key === 'stack' && typeof value === 'string') {
      return sanitizeStack(value);
    }
    if (value instanceof Error) {
      // Wave-13 C-9: recursively redact the `cause` chain. Prior behaviour
      // only emitted the top-level error's fields and dropped `cause`
      // entirely, hiding the root-cause context from log aggregators.
      return renderError(value, 0, new WeakSet<Error>());
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  };
}

/**
 * PERF-030: Object-key check that avoids allocating the `Object.keys(obj)`
 * array just to ask "does this object have any own enumerable keys?". Used by
 * the text-format path to decide whether to emit a JSON meta suffix.
 */
function hasOwnKeys(obj: Record<string, unknown>): boolean {
  for (const _k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, _k)) return true;
  }
  return false;
}

/**
 * Creates a structured logger.
 *
 * @example
 * ```ts
 * const logger = createLogger({ level: 'debug', json: true });
 * logger.info('server started', { port: 3000 });
 * const childLogger = logger.child({ requestId: 'abc' });
 * childLogger.debug('handling request');
 * ```
 */
export function createLogger(config?: LoggerConfig): Logger {
  const minLevel = config?.level ?? 'info';
  const json = config?.json ?? false;
  // eslint-disable-next-line no-console -- library fallback when no output provided
  const output = config?.output ?? console.log;
  // SEC-001 + T02 (Wave-5A): Build the redactor once at logger creation.
  // New defaulting semantics:
  //   - `redact === false`    → no redactor (explicit opt-out).
  //   - `redact === undefined`→ default redactor (useDefaultPattern: true).
  //   - `redact === object`   → exact user config.
  // `config?.redact ?? { useDefaultPattern: true }` is safe because the
  // `false` case is short-circuited above. Note that `{}` already activates
  // the default pattern inside `createRedactor`, so we choose `{ useDefaultPattern: true }`
  // as the explicit default sentinel for clarity.
  const redactor: Redactor | undefined =
    config?.redact === false
      ? undefined
      : createRedactor(config?.redact ?? { useDefaultPattern: true });
  const correlationId = config?.correlationId;
  const getContext = config?.getContext;
  // P2-14: resolve cwd for stack sanitization once at factory time.
  const stackSanitizerDisabled = config?.stackSanitizer?.disabled === true;
  const stackSanitizerCwd =
    config?.stackSanitizer?.cwd ?? (typeof process !== 'undefined' ? process.cwd() : '');
  const sanitizeStackFn = stackSanitizerDisabled
    ? undefined
    : (s: string): string => sanitizeStackTrace(s, { cwd: stackSanitizerCwd });

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[minLevel];
  }

  /**
   * P1-7: Evaluate the optional `getContext` hook and return a shallow
   * object of `trace_id` / `span_id` fields ready for merging. The hook
   * is fail-open: any throw or invalid return yields an empty object so a
   * buggy context provider cannot silence logs.
   */
  function resolveContextFields(): Record<string, unknown> {
    if (!getContext) return {};
    let ctx: { traceId?: string; spanId?: string } | undefined;
    try {
      ctx = getContext();
    } catch {
      return {};
    }
    if (!ctx) return {};
    const out: Record<string, unknown> = {};
    if (typeof ctx.traceId === 'string' && ctx.traceId.length > 0) out.trace_id = ctx.traceId;
    if (typeof ctx.spanId === 'string' && ctx.spanId.length > 0) out.span_id = ctx.spanId;
    return out;
  }

  function createLoggerWithMeta(baseMeta: Record<string, unknown>): Logger {
    function log(level: LogLevel, message: string, meta?: Readonly<Record<string, unknown>>): void {
      // PERF-030: Gate ALL work behind the level check. Previously we still
      // constructed `merged`, invoked the redactor, stamped a timestamp, and
      // built a replacer even when the call was below the configured level —
      // a common pattern in hot loops (`logger.debug(...)` at info level).
      // Now `debug()` under a production `info` logger is a single branch.
      if (!shouldLog(level)) return;
      // P1-7: Inject trace_id / span_id from the async context hook BEFORE
      // baseMeta / meta so caller fields win on collision. The hook never
      // overwrites explicit user fields (e.g. `logger.warn('x', { trace_id })`).
      const ctxFields = resolveContextFields();
      // OBS-001: Inject correlationId (if configured) before redaction so it
      // survives as-is — unless the caller intentionally overrides it in meta.
      const merged: Record<string, unknown> = {
        ...(correlationId !== undefined ? { correlationId } : {}),
        ...ctxFields,
        ...baseMeta,
        ...meta,
      };
      // SEC-001: Scrub sensitive keys FIRST. Runs before the replacer so keys
      // like `api_key` are replaced even if the value is a Date/Error/circular.
      const safeMerged = redactor ? sanitizeAttributes(merged, redactor) : merged;
      // Fix 10: Store as epoch millis, format only at output time
      const epochMs = Date.now();
      const timestamp = new Date(epochMs).toISOString();
      // Fix 9 + PERF-014: Use safe replacer for Error/Date/circular handling.
      // PERF-030: Only construct the replacer when we actually need to
      // stringify. Text mode without meta keys skips it entirely.
      // P2-14: Only thread the stack sanitizer when enabled.
      // `exactOptionalPropertyTypes` forbids `{ key: undefined }` against an
      // optional-only schema, so build the options object conditionally.
      const replacerOpts = sanitizeStackFn ? { sanitizeStack: sanitizeStackFn } : undefined;
      if (json) {
        const replacer = createSafeReplacer(replacerOpts);
        output(JSON.stringify({ level, message, timestamp, ...safeMerged }, replacer));
      } else if (hasOwnKeys(safeMerged)) {
        const replacer = createSafeReplacer(replacerOpts);
        const suffix = ' ' + JSON.stringify(safeMerged, replacer);
        output(`[${timestamp}] ${level.toUpperCase()} ${message}${suffix}`);
      } else {
        // No metadata → skip JSON.stringify entirely.
        output(`[${timestamp}] ${level.toUpperCase()} ${message}`);
      }
    }

    return {
      debug: (msg, meta) => log('debug', msg, meta),
      info: (msg, meta) => log('info', msg, meta),
      warn: (msg, meta) => log('warn', msg, meta),
      error: (msg, meta) => log('error', msg, meta),
      child: (meta: Readonly<Record<string, unknown>>) =>
        createLoggerWithMeta({ ...baseMeta, ...meta }),
      // Level-enabled companion for hot-path callers that want to skip
      // expensive metadata construction before hitting warn().
      isWarnEnabled: () => shouldLog('warn'),
    };
  }

  return createLoggerWithMeta({});
}
