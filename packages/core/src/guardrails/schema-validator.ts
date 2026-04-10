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
 * This validator supports basic JSON Schema validation including: type checking,
 * required properties, enum, minimum/maximum, minLength/maxLength, pattern,
 * and nested object/array validation.
 *
 * **$ref / $defs support:** Schemas using `$ref`, `$defs`, or other composition
 * features (allOf, anyOf, oneOf) must be pre-flattened before use. These keywords
 * are accepted in the schema type but are **not enforced** during validation.
 * For full JSON Schema support including `$ref` resolution, use `@harness-one/ajv`.
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
          // Redact ALL path segments after the first to prevent leaking internal schema structure
          const redactedPath = path.split('.').map((seg, i) => i === 0 ? seg : '[REDACTED]').join('.');
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
