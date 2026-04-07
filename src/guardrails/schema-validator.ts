/**
 * JSON Schema validator guardrail.
 *
 * @module
 */

import type { JsonSchema } from '../core/types.js';
import type { Guardrail } from './types.js';
import { validateJsonSchema } from '../_internal/json-schema.js';

/**
 * Create a guardrail that validates content as JSON against a schema.
 *
 * @example
 * ```ts
 * const validator = createSchemaValidator({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
 * ```
 */
export function createSchemaValidator(schema: JsonSchema): { name: string; guard: Guardrail } {
  const guard: Guardrail = (ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ctx.content);
    } catch {
      return { action: 'block', reason: 'Invalid JSON: content could not be parsed' };
    }

    const result = validateJsonSchema(schema, parsed);
    if (!result.valid) {
      const messages = result.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
      return { action: 'block', reason: `Schema validation failed: ${messages}` };
    }

    return { action: 'allow' };
  };

  return { name: 'schema-validator', guard };
}
