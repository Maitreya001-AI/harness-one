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
    }));
  }

  async function execute(call: ToolCallRequest): Promise<ToolResult> {
    // Rate limiting
    if (turnCalls >= maxPerTurn) {
      return toolError(
        `Exceeded max calls per turn (${maxPerTurn})`,
        'validation',
        'Wait for the next turn or reduce tool calls',
      );
    }
    if (sessionCalls >= maxPerSession) {
      return toolError(
        `Exceeded max calls per session (${maxPerSession})`,
        'validation',
        'Start a new session or reduce tool calls',
      );
    }

    // Lookup
    const tool = tools.get(call.name);
    if (!tool) {
      return toolError(
        `Tool "${call.name}" not found`,
        'not_found',
        'Check the tool name and ensure it is registered',
      );
    }

    // Permission check
    if (permissions && !permissions.check(call.name, undefined)) {
      return toolError(
        `Permission denied for tool "${call.name}"`,
        'permission',
        'Check that the caller has access to this tool',
      );
    }

    // Parse arguments
    let params: unknown;
    try {
      params = JSON.parse(call.arguments);
    } catch {
      return toolError(
        'Invalid JSON in tool call arguments',
        'validation',
        'Ensure arguments is valid JSON',
      );
    }

    // Validate
    const validation = customValidator
      ? customValidator.validate(tool.parameters, params)
      : validateToolCall(tool.parameters, params);
    if (!validation.valid) {
      const messages = validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return toolError(
        `Validation failed: ${messages}`,
        'validation',
        'Fix the parameters according to the schema',
      );
    }

    // Execute with optional timeout
    turnCalls++;
    sessionCalls++;
    if (timeoutMs !== undefined) {
      const result = await Promise.race([
        tool.execute(params),
        new Promise<ToolResult>((resolve) =>
          setTimeout(
            () =>
              resolve(
                toolError(
                  `Tool "${call.name}" timed out after ${timeoutMs}ms`,
                  'timeout',
                  'Consider increasing the timeout or optimizing the tool',
                  true,
                ),
              ),
            timeoutMs,
          ),
        ),
      ]);
      return result;
    }
    return tool.execute(params);
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

  return { register, get, list, schemas, execute, handler, resetTurn };
}
