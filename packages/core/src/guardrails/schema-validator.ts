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
export function createSchemaValidator(
  schema: JsonSchema,
  options?: { redactErrors?: boolean },
): { name: string; guard: Guardrail } {
  const redactErrors = options?.redactErrors ?? true;

  const guard: Guardrail = (ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ctx.content);
    } catch {
      return { action: 'block', reason: 'Invalid JSON: content could not be parsed' };
    }

    const result = validateJsonSchema(schema, parsed);
    if (!result.valid) {
      if (redactErrors) {
        const messages = result.errors.map((e) => {
          const path = e.path || '(root)';
          // Redact field names: replace the last segment after the last dot with [REDACTED]
          const redactedPath = path.replace(/\.([^.[]+)$/, '.[REDACTED]');
          // Redact specific field names from the message
          const redactedMessage = e.message
            .replace(/Property "([^"]+)"/g, 'Required field')
            .replace(/\b(?:minimum|maximum|minLength|maxLength)\s+\d+/g, (m) => m);
          return `${redactedPath}: ${redactedMessage}`;
        }).join('; ');
        return { action: 'block', reason: `Schema validation failed: ${messages}` };
      }
      const messages = result.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
      return { action: 'block', reason: `Schema validation failed: ${messages}` };
    }

    return { action: 'allow' };
  };

  return { name: 'schema-validator', guard };
}
