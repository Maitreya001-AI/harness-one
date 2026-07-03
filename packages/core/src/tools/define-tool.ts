/**
 * Factory function for creating tool definitions.
 *
 * @module
 */

import type { JsonSchema } from '../core/types.js';
import type { ToolDefinition, ToolResult, ToolCapabilityValue } from './types.js';
import type { FromSchema, ReadonlyJsonSchema } from './schema-infer.js';
import { toolError } from './types.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';

/** Supported JSON Schema types for tool parameters. */
const VALID_TYPES: Set<string> = new Set<string>([
  'string', 'number', 'integer', 'boolean', 'object', 'array', 'null',
]);

/**
 * Structural check for a thrown value that is already a {@link ToolResult}.
 * Matches the discriminated shape (`{kind:'error', success:false, error}` or
 * `{kind:'success', success:true, data}`) so the registry's runtime
 * `assertToolResult` accepts the preserved value unchanged.
 */
function isToolResultShaped(value: unknown): value is ToolResult {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { kind?: unknown; success?: unknown; error?: unknown; data?: unknown };
  if (v.kind === 'error' && v.success === false) {
    const feedback = v.error as { message?: unknown } | null | undefined;
    return (
      feedback !== null
      && feedback !== undefined
      && typeof feedback === 'object'
      && typeof feedback.message === 'string'
    );
  }
  if (v.kind === 'success' && v.success === true) return 'data' in v;
  return false;
}

/**
 * Validate that a JSON Schema uses supported features at definition time.
 * Throws HarnessError with code INVALID_TOOL_SCHEMA if the schema is malformed.
 */
function validateParametersSchema(schema: JsonSchema, path = 'parameters'): void {
  if (!schema || typeof schema !== 'object') {
    throw new HarnessError(
      `Invalid schema at ${path}: schema must be an object`,
      HarnessErrorCode.TOOL_INVALID_SCHEMA,
      'Provide a valid JSON Schema object for tool parameters',
    );
  }
  if (schema.type !== undefined && !VALID_TYPES.has(schema.type as string)) {
    throw new HarnessError(
      `Invalid schema type "${schema.type}" at ${path}: must be one of ${[...VALID_TYPES].join(', ')}`,
      HarnessErrorCode.TOOL_INVALID_SCHEMA,
      'Use a supported JSON Schema type',
    );
  }
  if (schema.properties !== undefined) {
    if (typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      throw new HarnessError(
        `Invalid schema at ${path}.properties: must be a plain object`,
        HarnessErrorCode.TOOL_INVALID_SCHEMA,
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
      HarnessErrorCode.TOOL_INVALID_SCHEMA,
      'Provide required as an array of property name strings',
    );
  }
}

/** Shape of the object passed to {@link defineTool}, parameterised by params + schema. */
interface DefineToolDef<TParams, TSchema extends JsonSchema | ReadonlyJsonSchema> {
  name: string;
  description: string;
  parameters: TSchema;
  responseFormat?: 'concise' | 'detailed';
  /**
   * Declared capabilities for the tool. See {@link ToolDefinition.capabilities}.
   * Optional (warn-only), planned to become required in 1.0.
   */
  capabilities?: readonly ToolCapabilityValue[];
  execute: (params: TParams, signal?: AbortSignal) => Promise<ToolResult>;
}

/**
 * Create a frozen ToolDefinition that wraps execute to catch errors.
 *
 * **Schema-inferred params (overload 1).** When `parameters` is an `as const`
 * schema literal, `params` is inferred from the schema — no explicit generic
 * required:
 *
 * ```ts
 * const tool = defineTool({
 *   name: 'search',
 *   description: 'Search issues',
 *   parameters: {
 *     type: 'object',
 *     properties: { q: { type: 'string' }, limit: { type: 'number' } },
 *     required: ['q'],
 *   } as const,
 *   execute: async (params) => toolSuccess(params.q), // params: { q: string; limit?: number }
 * });
 * ```
 *
 * A schema without `as const` conservatively yields `params: unknown`, matching
 * the pre-inference behaviour. See {@link FromSchema}.
 */
export function defineTool<S extends ReadonlyJsonSchema>(
  def: DefineToolDef<FromSchema<S>, S>,
): ToolDefinition<FromSchema<S>>;
/**
 * Create a frozen ToolDefinition (overload 2 — explicit params generic).
 *
 * Backward-compatible form. Pass the params type explicitly; it defaults to
 * `unknown` when omitted and the schema is not `as const`.
 *
 * @example
 * ```ts
 * const tool = defineTool<{ text: string }>({
 *   name: 'echo',
 *   description: 'Echoes input',
 *   parameters: { type: 'object', properties: { text: { type: 'string' } } },
 *   execute: async (params) => toolSuccess(params.text),
 * });
 * ```
 */
export function defineTool<TParams = unknown>(
  def: DefineToolDef<TParams, JsonSchema>,
): ToolDefinition<TParams>;
export function defineTool(
  def: DefineToolDef<never, JsonSchema | ReadonlyJsonSchema>,
): ToolDefinition<unknown> {
  // `parameters` may be a deep-`readonly` `as const` literal via overload 1;
  // widen to `JsonSchema` for the runtime validator and stored definition. The
  // schema is structurally identical — only its `readonly` modifiers differ.
  const parameters = def.parameters as JsonSchema;
  // Validate schema structure at definition time to catch malformed schemas early
  validateParametersSchema(parameters);

  // Variance bridge (internal, not `any`): the impl signature types `execute`
  // with the bottom `never` param so both overloads' `execute` shapes are
  // assignable to it. Invoke it through an `unknown`-param view — a single
  // `as` (the fn types are directionally comparable), not a double cast —
  // params are validated against `parameters` by the registry before every call.
  const runExecute = def.execute as (
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;

  const tool: ToolDefinition<unknown> = {
    name: def.name,
    description: def.description,
    parameters,
    ...(def.responseFormat !== undefined && { responseFormat: def.responseFormat }),
    ...(def.capabilities !== undefined && { capabilities: def.capabilities }),
    execute: async (params: unknown, signal?: AbortSignal): Promise<ToolResult> => {
      try {
        return await runExecute(params, signal);
      } catch (err) {
        // If the tool threw an already-structured ToolResult, preserve it
        // instead of collapsing it into a generic internal error.
        if (isToolResultShaped(err)) {
          return err;
        }
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message, 'internal', 'Check the tool implementation');
      }
    },
  };
  return tool;
}
