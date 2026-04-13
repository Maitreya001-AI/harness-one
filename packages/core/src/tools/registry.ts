/**
 * Tool registry — register, validate, and execute tools.
 *
 * @module
 */

import type { ToolCallRequest, ToolSchema } from '../core/types.js';
import type { ToolDefinition, ToolResult, SchemaValidator } from './types.js';
import { toolError } from './types.js';
import { validateToolCall } from './validate.js';
import { HarnessError } from '../core/errors.js';

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
export function createRegistry(config?: {
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
}): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  const maxPerTurn = config?.maxCallsPerTurn ?? Infinity;
  const maxPerSession = config?.maxCallsPerSession ?? Infinity;
  const customValidator = config?.validator;
  const permissions = config?.permissions;
  const timeoutMs = config?.timeoutMs;
  let turnCalls = 0;
  let sessionCalls = 0;

  function register(tool: ToolDefinition): void {
    if (!TOOL_NAME_RE.test(tool.name)) {
      throw new HarnessError(
        `Invalid tool name "${tool.name}": must match /^[a-zA-Z][a-zA-Z0-9_.]*$/`,
        'INVALID_TOOL_NAME',
        'Tool names must start with a letter and contain only letters, digits, dots, or underscores',
      );
    }
    if (tools.has(tool.name)) {
      throw new HarnessError(
        `Tool "${tool.name}" is already registered`,
        'DUPLICATE_TOOL',
        'Use a unique name or check registry.get() before registering',
      );
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

    // Parse arguments
    let params: unknown;
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
          timer = setTimeout(() => {
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

  return { register, get, list, schemas, execute, handler, resetTurn, resetSession };
}
