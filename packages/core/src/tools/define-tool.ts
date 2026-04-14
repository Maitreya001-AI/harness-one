/**
 * Factory function for creating tool definitions.
 *
 * @module
 */

import type { JsonSchema } from '../core/types.js';
import type { ToolDefinition, ToolResult, ToolCapabilityValue } from './types.js';
import { toolError } from './types.js';
import { HarnessError } from '../core/errors.js';

/** Supported JSON Schema types for tool parameters. */
const VALID_TYPES: Set<string> = new Set<string>([
  'string', 'number', 'integer', 'boolean', 'object', 'array', 'null',
]);

/**
 * Validate that a JSON Schema uses supported features at definition time.
 * Throws HarnessError with code INVALID_TOOL_SCHEMA if the schema is malformed.
 */
function validateParametersSchema(schema: JsonSchema, path = 'parameters'): void {
  if (!schema || typeof schema !== 'object') {
    throw new HarnessError(
      `Invalid schema at ${path}: schema must be an object`,
      'INVALID_TOOL_SCHEMA',
      'Provide a valid JSON Schema object for tool parameters',
    );
  }
  if (schema.type !== undefined && !VALID_TYPES.has(schema.type as string)) {
    throw new HarnessError(
      `Invalid schema type "${schema.type}" at ${path}: must be one of ${[...VALID_TYPES].join(', ')}`,
      'INVALID_TOOL_SCHEMA',
      'Use a supported JSON Schema type',
    );
  }
  if (schema.properties !== undefined) {
    if (typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      throw new HarnessError(
        `Invalid schema at ${path}.properties: must be a plain object`,
        'INVALID_TOOL_SCHEMA',
        'Define properties as a map of property names to schemas',
      );
    }
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      validateParametersSchema(propSchema, `${path}.properties.${key}`);
    }
  }
  if (schema.items !== undefined) {
    validateParametersSchema(schema.items, `${path}.items`);
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    throw new HarnessError(
      `Invalid schema at ${path}.required: must be an array of strings`,
      'INVALID_TOOL_SCHEMA',
      'Provide required as an array of property name strings',
    );
  }
}

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
  /**
   * Declared capabilities for the tool. See {@link ToolDefinition.capabilities}.
   * Optional in Wave-5A (warn-only), planned to become required in 1.0.
   */
  capabilities?: readonly ToolCapabilityValue[];
  execute: (params: TParams, signal?: AbortSignal) => Promise<ToolResult>;
}): ToolDefinition<TParams> {
  // Validate schema structure at definition time to catch malformed schemas early
  validateParametersSchema(def.parameters);

  const tool: ToolDefinition<TParams> = {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    ...(def.responseFormat !== undefined && { responseFormat: def.responseFormat }),
    ...(def.capabilities !== undefined && { capabilities: def.capabilities }),
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
