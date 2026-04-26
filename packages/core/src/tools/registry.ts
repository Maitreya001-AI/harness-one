/**
 * Tool registry — register, validate, and execute tools.
 *
 * @module
 */

import type { ToolCallRequest, ToolSchema } from '../core/types.js';
import type {
  ToolDefinition,
  ToolResult,
  SchemaValidator,
  ToolCapabilityValue,
} from './types.js';
import { toolError, ALL_TOOL_CAPABILITIES } from './types.js';
import { validateToolCall } from './validate.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { safeWarn } from '../infra/safe-log.js';
import { unrefTimeout } from '../infra/timers.js';
import type { Logger } from '../infra/logger.js';
import { randomUUID } from 'node:crypto';

/** Synthesise a unique tool-call id for `executeByName`. */
function synthesiseCallId(): string {
  return `executeByName-${randomUUID()}`;
}

/**
 * Resolved registry configuration — reflects the defaults applied by
 * {@link createRegistry} plus any caller overrides. Useful for assertions
 * and for operational visibility (e.g. surfacing the effective timeout).
 */
export interface ResolvedRegistryConfig {
  /** Hard cap on tool calls within a single turn (default: 20). */
  maxCallsPerTurn: number;
  /** Hard cap on tool calls within a session (default: 100). */
  maxCallsPerSession: number;
  /** Per-call timeout in ms (default: 30_000). `undefined` disables timeout. */
  timeoutMs: number | undefined;
  /**
   * cumulative byte cap on tool-call arguments within a single
   * turn (default: 10 MiB). Exceeding the cap throws `ADAPTER_PAYLOAD_OVERSIZED`.
   * Reset on `resetTurn()`.
   */
  maxTotalArgBytesPerTurn: number;
}

/** A registry that manages tool definitions and executes tool calls. */
export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(namespace?: string): ToolDefinition[];
  schemas(): ToolSchema[];
  execute(call: ToolCallRequest): Promise<ToolResult>;
  /**
   * Convenience entry point for ad-hoc tool execution — synthesises a
   * `ToolCallRequest` from `(name, args)` and forwards to {@link execute}.
   * Use this from runbooks, tests, custom drivers, and any caller that
   * does not already have a `ToolCallRequest` in hand. Caller-supplied
   * `args` is JSON-serialised internally; non-serialisable arguments
   * raise `TOOL_VALIDATION` synchronously.
   *
   * Use `execute(call)` when you already have a `ToolCallRequest`
   * (e.g. forwarded from `AgentLoop.run()`).
   *
   * Closes HARNESS_LOG HC-009.
   */
  executeByName(name: string, args: unknown): Promise<ToolResult>;
  handler(): (call: ToolCallRequest) => Promise<unknown>;
  resetTurn(): void;
  resetSession(): void;
  /** Return the effective configuration (defaults + caller overrides). */
  getConfig(): ResolvedRegistryConfig;
}

const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;

/** Configuration for {@link createRegistry}. */
export interface CreateRegistryConfig {
  maxCallsPerTurn?: number;
  maxCallsPerSession?: number;
  /** Custom schema validator (default: internal json-schema validator). */
  validator?: SchemaValidator;
  /** Optional permission checker called before tool execution. */
  permissions?: {
    check: (toolName: string, context?: Record<string, unknown>) => boolean;
  };
  /** Optional timeout in milliseconds for tool execution. */
  timeoutMs?: number;
  /**
   * cumulative cap on tool-argument bytes per turn. Default
   * 10 MiB. When exceeded, `execute()` throws `ADAPTER_PAYLOAD_OVERSIZED`.
   * Reset on `resetTurn()` / `resetSession()`.
   */
  maxTotalArgBytesPerTurn?: number;
  /**
   * capability allow-list enforced at `register()` time. Tools
   * declaring a capability outside this list are rejected with
   * `TOOL_CAPABILITY_DENIED`. Default: `['readonly']` (fail-closed).
   *
   * Use `createPermissiveRegistry()` to opt into all capabilities, or
   * pass an explicit list (e.g. `['readonly', 'filesystem']`) to whitelist
   * specific classes of tools.
   */
  allowedCapabilities?: readonly ToolCapabilityValue[];
  /**
   * Optional structured logger. When provided, registration-time warnings
   * (e.g. a tool missing its `capabilities` declaration) are routed here;
   * otherwise `safeWarn` falls back to the process-wide default logger.
   */
  logger?: Logger;
}

/**
 * Create a new tool registry.
 *
 * @example
 * ```ts
 * const registry = createRegistry({ maxCallsPerTurn: 10 });
 * registry.register(myTool);
 * const result = await registry.execute({ id: '1', name: 'myTool', arguments: '{}' });
 * ```
 */
export function createRegistry(config?: CreateRegistryConfig): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  // production-grade defaults. Callers can still opt out by passing
  // `Infinity` (rate limits) or their own numeric override (timeout).
  const maxPerTurn = config?.maxCallsPerTurn ?? 20;
  const maxPerSession = config?.maxCallsPerSession ?? 100;
  const customValidator = config?.validator;
  const permissions = config?.permissions;
  const timeoutMs = config?.timeoutMs ?? 30_000;
  // per-turn cumulative argument byte cap. 10 MiB default.
  const maxTotalArgBytesPerTurn = config?.maxTotalArgBytesPerTurn ?? 10 * 1024 * 1024;
  // capability allow-list. Default fail-closed to `readonly` only.
  const allowedCapabilities = new Set<ToolCapabilityValue>(
    config?.allowedCapabilities ?? ['readonly'],
  );
  const logger = config?.logger;
  let turnCalls = 0;
  let sessionCalls = 0;
  // cumulative arg bytes consumed this turn.
  let turnArgBytes = 0;

  function register(tool: ToolDefinition): void {
    if (!TOOL_NAME_RE.test(tool.name)) {
      throw new HarnessError(
        `Invalid tool name "${tool.name}": must match /^[a-zA-Z][a-zA-Z0-9_.]*$/`,
        HarnessErrorCode.TOOL_INVALID_NAME,
        'Tool name must start with a letter and contain only letters, digits, underscores, and dots',
      );
    }
    if (tools.has(tool.name)) {
      throw new HarnessError(
        `Tool "${tool.name}" is already registered`,
        HarnessErrorCode.TOOL_DUPLICATE,
        'Use a unique name or check registry.get() before registering',
      );
    }

    // -----------------------------------------------------------------
    // Capability allow-list enforcement.
    //
    // ORDERING (INT-09-01): capability check runs at register()-time and
    // therefore necessarily precedes the permission check (which runs at
    // execute()-time). Do NOT move this check below or into execute() —
    // its whole point is to *prevent registration* of disallowed tools so
    // they cannot be reached at all.
    //
    // upgrade plan (breaking, deferred to avoid a double breaking
    // window with defaults):
    //   1. `ToolDefinition.capabilities` becomes required (TS-level break).
    //   2. Missing capabilities escalate from safeWarn to throw
    //      TOOL_CAPABILITY_DENIED.
    //   3. Keep warning so legacy tools still load.
    // -----------------------------------------------------------------
    if (tool.capabilities === undefined) {
      safeWarn(
        logger,
        `tool "${tool.name}" missing capabilities declaration — will be required in 1.0`,
        { tool: tool.name },
      );
    } else {
      for (const cap of tool.capabilities) {
        if (!allowedCapabilities.has(cap)) {
          throw new HarnessError(
            `tool "${tool.name}" declares capability "${cap}" not in registry allow-list`,
            HarnessErrorCode.TOOL_CAPABILITY_DENIED,
            `Add "${cap}" to createRegistry({ allowedCapabilities }) or use createPermissiveRegistry()`,
          );
        }
      }
    }

    tools.set(tool.name, tool);
  }

  function get(name: string): ToolDefinition | undefined {
    return tools.get(name);
  }

  function list(namespace?: string): ToolDefinition[] {
    const all = Array.from(tools.values());
    if (namespace === undefined) return all;
    const prefix = namespace + '.';
    return all.filter((t) => t.name.startsWith(prefix));
  }

  function schemas(): ToolSchema[] {
    return Array.from(tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.responseFormat !== undefined && { responseFormat: t.responseFormat }),
    }));
  }

  /**
   * Refund the turn/session counters claimed at the top of `execute()` for
   * a call that failed pre-execution checks. Pure bookkeeping helper kept in
   * one place so every reject path mirrors the same accounting.
   */
  function refundClaimedCounters(): void {
    turnCalls--;
    sessionCalls--;
  }

  /**
   * Resolve the tool, parse arguments, run the schema validator, and apply
   * the permission check. Returns either the admitted call (`tool` + `params`
   * ready for execution) or a `toolError` to short-circuit. THROWS only for
   * the cumulative byte-cap violation, which the public contract surfaces as
   * a HarnessError instead of a tool reply.
   *
   * Counter refunds are applied here so every reject path stays in one place.
   */
  async function admitCallForExecution(
    call: ToolCallRequest,
  ): Promise<
    | { ok: true; tool: ToolDefinition; params: unknown }
    | { ok: false; result: ToolResult }
  > {
    // Lookup
    const tool = tools.get(call.name);
    if (!tool) {
      refundClaimedCounters();
      return {
        ok: false,
        result: toolError(
          `Tool "${call.name}" not found`,
          'not_found',
          'Check the tool name and ensure it is registered',
        ),
      };
    }

    // Per-call byte cap — protects direct registry.execute() calls that
    // bypass AgentLoop's maxToolArgBytes streaming guard.
    const MAX_ARG_BYTES = 5 * 1024 * 1024; // 5 MiB, matching AgentLoop default
    const argByteLen = Buffer.byteLength(call.arguments, 'utf8');
    if (argByteLen > MAX_ARG_BYTES) {
      refundClaimedCounters();
      return {
        ok: false,
        result: toolError(
          `Tool call arguments exceed maximum size (${MAX_ARG_BYTES} bytes)`,
          'validation',
          'Reduce the size of tool call arguments',
        ),
      };
    }

    // cumulative per-turn argument byte cap. Throw to make the
    // violation explicit to supervising loops.
    if (turnArgBytes + argByteLen > maxTotalArgBytesPerTurn) {
      refundClaimedCounters();
      throw new HarnessError(
        `Cumulative tool-argument bytes exceeded per-turn cap (${turnArgBytes + argByteLen} > ${maxTotalArgBytesPerTurn} bytes)`,
        HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED,
        'Reduce per-call argument size, raise maxTotalArgBytesPerTurn, or call resetTurn() to start a new turn',
      );
    }
    turnArgBytes += argByteLen;

    // Parse arguments
    let params: unknown;
    try {
      params = JSON.parse(call.arguments);
    } catch (err) {
      refundClaimedCounters();
      // Preserve the SyntaxError on `cause` so failure-inspection paths can
      // pick up the position hint without breaking JSON.stringify(result).
      const syntaxMessage = err instanceof SyntaxError ? err.message : String(err);
      const result = toolError(
        `Invalid JSON in tool call arguments (${syntaxMessage})`,
        'validation',
        'Ensure arguments is valid JSON',
      );
      if (err instanceof Error) {
        Object.defineProperty(result, 'cause', {
          value: err,
          enumerable: false,
          configurable: true,
          writable: false,
        });
      }
      return { ok: false, result };
    }

    // Schema validate (await — validator may be async, e.g. AjvSchemaValidator)
    const validation = await Promise.resolve(
      customValidator
        ? customValidator.validate(tool.parameters, params)
        : validateToolCall(tool.parameters, params),
    );
    if (!validation.valid) {
      refundClaimedCounters();
      const messages = validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return {
        ok: false,
        result: toolError(
          `Validation failed: ${messages}`,
          'validation',
          'Fix the parameters according to the schema',
        ),
      };
    }

    // Permission (after parsing + validation so params are available)
    if (permissions && !permissions.check(call.name, { toolCallId: call.id, params })) {
      refundClaimedCounters();
      return {
        ok: false,
        result: toolError(
          `Permission denied for tool "${call.name}"`,
          'permission',
          'Check that the caller has access to this tool',
        ),
      };
    }

    return { ok: true, tool, params };
  }

  /**
   * Build a middleware chain terminating in the raw `tool.execute()`. The
   * middleware array is invoked outermost-first — the first entry wraps the
   * second, which wraps the third, and so on, with `tool.execute()` at the
   * tail (Koa/Express onion semantics).
   */
  function buildToolMiddlewareChain(
    tool: ToolDefinition,
    params: unknown,
    callName: string,
    sig?: AbortSignal,
  ): () => Promise<ToolResult> {
    const mws = tool.middleware ?? [];
    let chain: () => Promise<ToolResult> = () => tool.execute(params, sig);
    for (let i = mws.length - 1; i >= 0; i--) {
      const mw = mws[i];
      const downstream = chain;
      chain = () => mw({ toolName: callName, params, ...(sig !== undefined && { signal: sig }) }, downstream);
    }
    return chain;
  }

  async function execute(call: ToolCallRequest): Promise<ToolResult> {
    // Atomic rate limiting: increment FIRST, then check limits.
    // This prevents TOCTOU races where concurrent calls both pass the check
    // before either increments.
    turnCalls++;
    sessionCalls++;

    if (turnCalls > maxPerTurn) {
      refundClaimedCounters();
      return toolError(
        `Exceeded max calls per turn (${maxPerTurn})`,
        'validation',
        'Wait for the next turn or reduce tool calls',
      );
    }
    if (sessionCalls > maxPerSession) {
      refundClaimedCounters();
      return toolError(
        `Exceeded max calls per session (${maxPerSession})`,
        'validation',
        'Start a new session or reduce tool calls',
      );
    }

    const admission = await admitCallForExecution(call);
    if (!admission.ok) return admission.result;
    const { tool, params } = admission;
    const buildChain = (sig?: AbortSignal): (() => Promise<ToolResult>) =>
      buildToolMiddlewareChain(tool, params, call.name, sig);

    /**
     * runtime shape assertion for tool return values.
     *
     * Tool implementations are typed to return `ToolResult`, but JS callers
     * (or buggy middleware) can still return a plain object, a string, `null`,
     * or a Promise that resolves to garbage. We guard the handler path here so
     * the rest of the registry (and downstream loop) always sees a valid
     * `ToolResult` discriminated union.
     */
    function assertToolResult(value: unknown): ToolResult {
      if (
        value !== null &&
        typeof value === 'object' &&
        ('success' in value) &&
        typeof (value as { success: unknown }).success === 'boolean' &&
        // The `kind` tag is also required for new-style discriminated matching.
        ('kind' in value) &&
        ((value as { kind: unknown }).kind === 'success' || (value as { kind: unknown }).kind === 'error')
      ) {
        return value as ToolResult;
      }
      return toolError(
        `Tool "${call.name}" returned unexpected type (not a ToolResult)`,
        'internal',
        'Ensure the tool returns toolSuccess()/toolError() or an equivalent ToolResult object',
      );
    }

    // Execute with optional timeout using a simple timer promise pattern
    // that avoids listener leaks by not attaching abort signal listeners.
    //
    // The timeout branch mirrors the non-timeout branch's try/catch
    // so a throwing tool.execute() is converted into a `toolError` reply
    // instead of propagating. Rate-limit counters (turnCalls / sessionCalls)
    // are pre-claimed; we keep them claimed whether the tool succeeds, errors,
    // or times out AFTER starting — the counters are refunded only for
    // pre-execution errors (lookup/validation/permission) above.
    if (timeoutMs !== undefined) {
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // when a tool keeps running long after the signal has
      // fired, warn so operators can identify tools that ignore the signal
      // (see ToolDefinition.execute TSDoc). Threshold: 2× timeout.
      let nonResponsiveTimer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      // wrap the raw chain in the shape assertion so garbage return
      // values cannot propagate up through the Promise.race winner.
      const chainPromise = buildChain(ac.signal)().then(assertToolResult);
      try {
        const timeoutPromise = new Promise<ToolResult>((resolve) => {
          // unref so an abandoned Promise.race doesn't hold the
          // event loop open past the caller's expected process lifetime.
          timer = unrefTimeout(() => {
            timedOut = true;
            ac.abort();
            // Arm the non-responsive-tool detector.
            nonResponsiveTimer = unrefTimeout(() => {
              safeWarn(
                logger,
                `tool "${call.name}" did not resolve within ${timeoutMs}ms after abort — possible signal-ignoring implementation`,
                { tool: call.name, timeoutMs },
              );
            }, timeoutMs);
            // Attach a best-effort cleanup so the non-responsive timer fires
            // at most once per invocation.
            chainPromise.finally(() => {
              if (nonResponsiveTimer !== undefined) {
                clearTimeout(nonResponsiveTimer);
                nonResponsiveTimer = undefined;
              }
            }).catch(() => {
              // Swallow — the chain promise's failure is handled by the
              // Promise.race below; we only care about clearing the timer.
            });
            resolve(
              toolError(
                `Tool "${call.name}" timed out after ${timeoutMs}ms`,
                'timeout',
                'Consider increasing the timeout or optimizing the tool',
                true,
              ),
            );
          }, timeoutMs);
        });

        try {
          return await Promise.race([chainPromise, timeoutPromise]);
        } catch (err) {
          // Same error-to-toolError conversion as the non-timeout path.
          return toolError(
            err instanceof Error ? err.message : String(err),
            'internal',
            'Tool execution failed unexpectedly',
          );
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (!timedOut && nonResponsiveTimer !== undefined) clearTimeout(nonResponsiveTimer);
        // Abort the controller to cancel any in-flight tool work
        ac.abort();
      }
    }
    // Wrap non-timeout execution in try-catch to prevent rate limiter budget leak.
    // If tool.execute() throws (instead of returning a ToolResult error),
    // the pre-claimed turnCalls/sessionCalls counters would never be decremented.
    try {
      // same shape assertion as the timeout branch.
      return assertToolResult(await buildChain()());
    } catch (err) {
      return toolError(
        err instanceof Error ? err.message : String(err),
        'internal',
        'Tool execution failed unexpectedly',
      );
    }
  }

  function handler(): (call: ToolCallRequest) => Promise<unknown> {
    return async (call: ToolCallRequest): Promise<unknown> => {
      const result = await execute(call);
      return result.success ? result.data : result;
    };
  }

  function resetTurn(): void {
    turnCalls = 0;
    // reset per-turn byte counter on turn boundaries.
    turnArgBytes = 0;
  }

  function resetSession(): void {
    sessionCalls = 0;
    turnCalls = 0;
    // session reset implies a new turn.
    turnArgBytes = 0;
  }

  function getConfig(): ResolvedRegistryConfig {
    return {
      maxCallsPerTurn: maxPerTurn,
      maxCallsPerSession: maxPerSession,
      timeoutMs,
      maxTotalArgBytesPerTurn,
    };
  }

  /**
   * Convenience wrapper around {@link execute} for ad-hoc callers.
   * See {@link ToolRegistry.executeByName} for the contract.
   */
  async function executeByName(name: string, args: unknown): Promise<ToolResult> {
    if (typeof name !== 'string' || name.length === 0) {
      return toolError(
        'executeByName: tool name must be a non-empty string',
        'validation',
        'Pass the tool name string registered via registry.register()',
      );
    }
    let serialised: string;
    try {
      // Tools historically receive JSON-string arguments because the
      // upstream LLM adapter delivers them that way. Synthesise the
      // same shape so middleware, validators, and the byte-budget
      // accountant see the same payload as a real LLM-driven call.
      serialised = JSON.stringify(args ?? {});
    } catch (err) {
      return toolError(
        `executeByName: failed to JSON-serialise args for tool "${name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        'validation',
        'Pass a JSON-serialisable object (no cycles, no BigInt, no functions).',
      );
    }
    const id = synthesiseCallId();
    return execute({ id, name, arguments: serialised });
  }

  // add a Symbol.toStringTag marker so Object.prototype.toString
  // surfaces a descriptive tag (e.g. `[object HarnessToolRegistry]`) for
  // debuggers and structured-logging pretty-printers.
  const registry: ToolRegistry = { register, get, list, schemas, execute, executeByName, handler, resetTurn, resetSession, getConfig };
  Object.defineProperty(registry, Symbol.toStringTag, {
    value: 'HarnessToolRegistry',
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return registry;
}

/**
 * Convenience factory that pre-sets `allowedCapabilities` to every
 * {@link ALL_TOOL_CAPABILITIES} value. Useful in environments where the
 * caller has already performed capability review out-of-band (tests,
 * sandboxed processes, user-owned shells) and wants to accept any tool
 * without per-site opt-in.
 *
 * @example
 * ```ts
 * const registry = createPermissiveRegistry({ timeoutMs: 10_000 });
 * registry.register(shellTool);   // capabilities: ['shell']
 * registry.register(networkTool); // capabilities: ['network']
 * ```
 */
export function createPermissiveRegistry(
  config?: Omit<CreateRegistryConfig, 'allowedCapabilities'>,
): ToolRegistry {
  return createRegistry({ ...config, allowedCapabilities: [...ALL_TOOL_CAPABILITIES] });
}
