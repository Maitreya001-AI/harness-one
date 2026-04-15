/**
 * Tool call parameter validation using the internal JSON Schema validator.
 *
 * @module
 */

import type { JsonSchema } from '../core/types.js';
import type { ValidationError } from './types.js';
import { validateJsonSchema } from '../infra/json-schema.js';

/**
 * Validate tool call parameters against a JSON Schema.
 *
 * @example
 * ```ts
 * const result = validateToolCall(
 *   { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
 *   { name: 'Alice' }
 * );
 * // { valid: true, errors: [] }
 * ```
 */
export function validateToolCall(
  schema: JsonSchema,
  params: unknown,
): { valid: boolean; errors: ValidationError[] } {
  const result = validateJsonSchema(schema, params);
  return {
    valid: result.valid,
    errors: result.errors.map((e) => ({
      path: e.path,
      message: e.message,
    })),
  };
}
