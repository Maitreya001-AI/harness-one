/**
 * Factory function for creating tool definitions.
 *
 * @module
 */

import type { JsonSchema } from '../core/types.js';
import type { ToolDefinition, ToolResult } from './types.js';
import { toolError } from './types.js';

/**
 * Create a frozen ToolDefinition that wraps execute to catch errors.
 *
 * @example
 * ```ts
 * const tool = defineTool({
 *   name: 'echo',
 *   description: 'Echoes input',
 *   parameters: { type: 'object', properties: { text: { type: 'string' } } },
 *   execute: async (params) => toolSuccess(params.text),
 * });
 * ```
 */
export function defineTool<TParams = unknown>(def: {
  name: string;
  description: string;
  parameters: JsonSchema;
  responseFormat?: 'concise' | 'detailed';
  execute: (params: TParams, signal?: AbortSignal) => Promise<ToolResult>;
}): ToolDefinition<TParams> {
  const tool: ToolDefinition<TParams> = {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    ...(def.responseFormat !== undefined && { responseFormat: def.responseFormat }),
    execute: async (params: TParams, signal?: AbortSignal): Promise<ToolResult> => {
      try {
        return await def.execute(params, signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, 'internal', 'Check the tool implementation');
      }
    },
  };
  return Object.freeze(tool);
}
