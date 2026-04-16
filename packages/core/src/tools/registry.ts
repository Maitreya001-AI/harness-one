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
import type { Logger } from '../observe/logger.js';

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
}

/** A registry that manages tool definitions and executes tool calls. */
export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(namespace?: string): ToolDefinition[];
  schemas(): ToolSchema[];
  execute(call: ToolCallRequest): Promise<ToolResult>;
  handler(): (call: ToolCallRequest) => Promise<unknown>;
  resetTurn(): void;
  resetSession(): void;
  /** Return the effective configuration (defaults + caller overrides). */
  getConfig(): ResolvedRegistryConfig;
}

const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;

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
   * Wave-5A: capability allow-list enforced at `register()` time. Tools
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

export function createRegistry(config?: CreateRegistryConfig): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  // T08: production-grade defaults. Callers can still opt out by passing
  // `Infinity` (rate limits) or their own numeric override (timeout).
  const maxPerTurn = config?.maxCallsPerTurn ?? 20;
  const maxPerSession = config?.maxCallsPerSession ?? 100;
  const customValidator = config?.validator;
  const permissions = config?.permissions;
  const timeoutMs = config?.timeoutMs ?? 30_000;
  // T09: capability allow-list. Default fail-closed to `readonly` only.
  const allowedCapabilities = new Set<ToolCapabilityValue>(
    config?.allowedCapabilities ?? ['readonly'],
  );
  const logger = config?.logger;
  let turnCalls = 0;
  let sessionCalls = 0;

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
    // T09: Capability allow-list enforcement.
    //
    // ORDERING (INT-09-01): capability check runs at register()-time and
    // therefore necessarily precedes the permission check (which runs at
    // execute()-time). Do NOT move this check below or into execute() —
    // its whole point is to *prevent registration* of disallowed tools so
    // they cannot be reached at all.
    //
    // Wave-5C upgrade plan (breaking, deferred to avoid a double breaking
    // window with Wave-5A defaults):
    //   1. `ToolDefinition.capabilities` becomes required (TS-level break).
    //   2. Missing capabilities escalate from safeWarn to throw
    //      TOOL_CAPABILITY_DENIED.
    //   3. Keep warning in Wave-5A so legacy tools still load.
    // -----------------------------------------------------------------
    if (tool.capabilities === undefined) {
      safeWarn(
        logger,
        `tool "${tool.name}" missing capabilities declaration — will be required in 1.0 (Wave-5C)`,
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

  async function execute(call: ToolCallRequest): Promise<ToolResult> {
    // Atomic rate limiting: increment FIRST, then check limits.
    // This prevents TOCTOU races where concurrent calls both pass the check
    // before either increments.
    turnCalls++;
    sessionCalls++;

    if (turnCalls > maxPerTurn) {
      turnCalls--;
      sessionCalls--;
      return toolError(
        `Exceeded max calls per turn (${maxPerTurn})`,
        'validation',
        'Wait for the next turn or reduce tool calls',
      );
    }
    if (sessionCalls > maxPerSession) {
      turnCalls--;
      sessionCalls--;
      return toolError(
        `Exceeded max calls per session (${maxPerSession})`,
        'validation',
        'Start a new session or reduce tool calls',
      );
    }

    // Lookup
    const tool = tools.get(call.name);
    if (!tool) {
      turnCalls--;
      sessionCalls--;
      return toolError(
        `Tool "${call.name}" not found`,
        'not_found',
        'Check the tool name and ensure it is registered',
      );
    }

    // Parse arguments — enforce a byte-length cap before parsing so a direct
    // registry.execute() call (bypassing AgentLoop's maxToolArgBytes streaming
    // guard) cannot DoS the event loop with oversized payloads.
    const MAX_ARG_BYTES = 5 * 1024 * 1024; // 5 MiB, matching AgentLoop default
    let params: unknown;
    if (Buffer.byteLength(call.arguments, 'utf8') > MAX_ARG_BYTES) {
      turnCalls--;
      sessionCalls--;
      return toolError(
        `Tool call arguments exceed maximum size (${MAX_ARG_BYTES} bytes)`,
        'validation',
        'Reduce the size of tool call arguments',
      );
    }
    try {
      params = JSON.parse(call.arguments);
    } catch {
      turnCalls--;
      sessionCalls--;
      return toolError(
        'Invalid JSON in tool call arguments',
        'validation',
        'Ensure arguments is valid JSON',
      );
    }

    // Validate (await in case validator is async, e.g., AjvSchemaValidator)
    const validation = await Promise.resolve(
      customValidator
        ? customValidator.validate(tool.parameters, params)
        : validateToolCall(tool.parameters, params),
    );
    if (!validation.valid) {
      turnCalls--;
      sessionCalls--;
      const messages = validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return toolError(
        `Validation failed: ${messages}`,
        'validation',
        'Fix the parameters according to the schema',
      );
    }

    // Permission check (after parsing and validation so params are available)
    if (permissions && !permissions.check(call.name, { toolCallId: call.id, params })) {
      turnCalls--;
      sessionCalls--;
      return toolError(
        `Permission denied for tool "${call.name}"`,
        'permission',
        'Check that the caller has access to this tool',
      );
    }

    /**
     * Build a middleware chain terminating in the raw tool.execute(). Middleware
     * array is invoked outermost-first — the first entry wraps the second,
     * which wraps the third, and so on, with tool.execute() at the tail. This
     * mirrors Koa/Express style onion semantics.
     *
     * `resolvedTool` is passed explicitly because TypeScript's control-flow
     * narrowing doesn't follow into a nested function body — inside buildChain,
     * `tool` would be typed as `ToolDefinition | undefined` even though we
     * guard against undefined above.
     */
    const resolvedTool = tool;
    function buildChain(sig?: AbortSignal): () => Promise<ToolResult> {
      const mws = resolvedTool.middleware ?? [];
      let chain: () => Promise<ToolResult> = () => resolvedTool.execute(params, sig);
      for (let i = mws.length - 1; i >= 0; i--) {
        const mw = mws[i];
        const downstream = chain;
        chain = () => mw({ toolName: call.name, params, ...(sig !== undefined && { signal: sig }) }, downstream);
      }
      return chain;
    }

    // Execute with optional timeout using a simple timer promise pattern
    // that avoids listener leaks by not attaching abort signal listeners.
    //
    // CQ-008: The timeout branch mirrors the non-timeout branch's try/catch
    // so a throwing tool.execute() is converted into a `toolError` reply
    // instead of propagating. Rate-limit counters (turnCalls / sessionCalls)
    // are pre-claimed; we keep them claimed whether the tool succeeds, errors,
    // or times out AFTER starting — the counters are refunded only for
    // pre-execution errors (lookup/validation/permission) above.
    if (timeoutMs !== undefined) {
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<ToolResult>((resolve) => {
          // Wave-5F m-2: unref so an abandoned Promise.race doesn't hold the
          // event loop open past the caller's expected process lifetime.
          timer = unrefTimeout(() => {
            ac.abort();
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

        const chain = buildChain(ac.signal);
        try {
          return await Promise.race([chain(), timeoutPromise]);
        } catch (err) {
          // CQ-008: Same error-to-toolError conversion as the non-timeout path.
          return toolError(
            err instanceof Error ? err.message : String(err),
            'internal',
            'Tool execution failed unexpectedly',
          );
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // Abort the controller to cancel any in-flight tool work
        ac.abort();
      }
    }
    // Wrap non-timeout execution in try-catch to prevent rate limiter budget leak.
    // If tool.execute() throws (instead of returning a ToolResult error),
    // the pre-claimed turnCalls/sessionCalls counters would never be decremented.
    try {
      return await buildChain()();
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
  }

  function resetSession(): void {
    sessionCalls = 0;
    turnCalls = 0;
  }

  function getConfig(): ResolvedRegistryConfig {
    return {
      maxCallsPerTurn: maxPerTurn,
      maxCallsPerSession: maxPerSession,
      timeoutMs,
    };
  }

  return { register, get, list, schemas, execute, handler, resetTurn, resetSession, getConfig };
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
