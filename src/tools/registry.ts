/**
 * Tool registry — register, validate, and execute tools.
 *
 * @module
 */

import type { ToolCallRequest, ToolSchema } from '../core/types.js';
import type { ToolDefinition, ToolResult } from './types.js';
import { toolError } from './types.js';
import { validateToolCall } from './validate.js';

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
}): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  const maxPerTurn = config?.maxCallsPerTurn ?? Infinity;
  const maxPerSession = config?.maxCallsPerSession ?? Infinity;
  let turnCalls = 0;
  let sessionCalls = 0;

  function register(tool: ToolDefinition): void {
    if (!TOOL_NAME_RE.test(tool.name)) {
      throw new Error(
        `Invalid tool name "${tool.name}": must match /^[a-zA-Z][a-zA-Z0-9_.]*$/`,
      );
    }
    if (tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
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
    const validation = validateToolCall(tool.parameters, params);
    if (!validation.valid) {
      const messages = validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return toolError(
        `Validation failed: ${messages}`,
        'validation',
        'Fix the parameters according to the schema',
      );
    }

    // Execute
    turnCalls++;
    sessionCalls++;
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
