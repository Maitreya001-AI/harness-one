/**
 * JSON Schema validator guardrail.
 *
 * @module
 */

import type { JsonSchema } from '../core/types.js';
import type { Guardrail } from './types.js';
import { validateJsonSchema } from '../_internal/json-schema.js';

/** Default maximum byte length for JSON content (1 MiB). Protects against DoS via oversized payloads. */
const DEFAULT_MAX_JSON_BYTES = 1_048_576;

/**
 * Measure the UTF-8 byte length of a string without allocating a Buffer
 * (runtime-agnostic: works in Node, Deno, browsers, and Workers).
 */
function utf8ByteLength(s: string): number {
  // TextEncoder is available in all supported JS runtimes.
  return new TextEncoder().encode(s).length;
}

/**
 * Create a guardrail that validates content as JSON against a schema.
 *
 * This validator supports basic JSON Schema validation including: type checking,
 * required properties, enum, minimum/maximum, minLength/maxLength, pattern,
 * and nested object/array validation.
 *
 * **Size cap (SEC-006):** By default the guard rejects content larger than 1 MiB
 * (`maxJsonBytes`) before passing it to `JSON.parse`. This prevents CPU / memory
 * amplification from pathological JSON inputs (e.g., `[[[[[...]]]]]` deeply
 * nested payloads) that would otherwise stall the event loop.
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
  options?: {
    redactErrors?: boolean;
    /**
     * Maximum UTF-8 byte length of `ctx.content` before it is passed to
     * `JSON.parse`. Content exceeding this is blocked without parsing.
     * Default: 1_048_576 (1 MiB). Set to `0` to disable the size check.
     */
    maxJsonBytes?: number;
  },
): { name: string; guard: Guardrail } {
  const redactErrors = options?.redactErrors ?? true;
  const maxJsonBytes = options?.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;

  const guard: Guardrail = (ctx) => {
    // SEC-006: block oversized payloads BEFORE handing them to JSON.parse.
    // We check UTF-8 byte length (not string .length) because one JS code unit
    // can encode up to 4 bytes — counting code units would under-estimate size.
    if (maxJsonBytes > 0) {
      const byteLen = utf8ByteLength(ctx.content);
      if (byteLen > maxJsonBytes) {
        return {
          action: 'block',
          reason: `Schema validation failed: content exceeds max size (${byteLen} > ${maxJsonBytes} bytes)`,
        };
      }
    }

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
