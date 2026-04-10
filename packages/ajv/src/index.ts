/**
 * @harness-one/ajv — Ajv JSON Schema validator for harness-one.
 *
 * Replaces the built-in lightweight validator with full JSON Schema support
 * including $ref, oneOf, anyOf, formats, and custom keywords.
 *
 * **Note on ajv-formats:** Format validation (email, uri, date-time, etc.)
 * requires the optional `ajv-formats` package (>= 3.0.0). When not installed,
 * format keywords are silently ignored. Install it as a peer/optional dependency
 * to enable format validation.
 *
 * @module
 */

import { Ajv } from 'ajv';
import type { JsonSchema } from 'harness-one/core';
import type { SchemaValidator, ValidationError } from 'harness-one/tools';

/** Options for the Ajv validator. */
export interface AjvValidatorOptions {
  /** Report all errors instead of stopping at the first one. Defaults to true. */
  readonly allErrors?: boolean;
  /** Enable format validators (email, uri, date-time, etc.). Defaults to true. */
  readonly formats?: boolean;
}

/** Generate a human-readable suggestion from an Ajv error. */
function formatSuggestion(err: {
  keyword: string;
  params: Record<string, unknown>;
  instancePath: string;
}): string {
  switch (err.keyword) {
    case 'required':
      return `Add the required property "${err.params.missingProperty}"`;
    case 'type':
      return `Change the value at ${err.instancePath || 'root'} to type "${err.params.type}"`;
    case 'enum':
      return `Use one of the allowed values: ${JSON.stringify(err.params.allowedValues)}`;
    case 'format':
      return `Provide a valid ${err.params.format} string`;
    case 'oneOf':
      return 'Value must match exactly one of the specified schemas';
    case 'anyOf':
      return 'Value must match at least one of the specified schemas';
    default:
      return `Fix the ${err.keyword} constraint at ${err.instancePath || 'root'}`;
  }
}

/**
 * Cached result of the lazy ajv-formats ESM dynamic import.
 * null means the import was attempted and ajv-formats was not found.
 */
let formatsLoader: Promise<((ajv: InstanceType<typeof Ajv>) => void) | null> | undefined;

function loadFormats(): Promise<((ajv: InstanceType<typeof Ajv>) => void) | null> {
  if (!formatsLoader) {
    formatsLoader = import('ajv-formats')
      .then((mod) => {
        const addFormats = typeof mod === 'function' ? mod : (mod.default ?? mod);
        return typeof addFormats === 'function' ? addFormats : null;
      })
      .catch(() => null); // ajv-formats not installed — format validation will be skipped
  }
  return formatsLoader;
}

/**
 * Create a SchemaValidator backed by Ajv, supporting full JSON Schema draft-07+.
 *
 * This replaces the built-in lightweight validator when you need:
 * - $ref / $defs for schema composition
 * - oneOf / anyOf / allOf combinators
 * - String formats (email, uri, date-time, etc.) when ajv-formats is installed
 * - Custom keywords and vocabularies
 *
 * Format loading is lazy: on the first call to `validate()`, the validator
 * will attempt to dynamically import `ajv-formats` (ESM `import()`) and cache
 * the result for all subsequent validations. This keeps the factory function
 * synchronous while avoiding `require()`.
 */
export function createAjvValidator(options?: AjvValidatorOptions): SchemaValidator {
  const ajv = new Ajv({
    allErrors: options?.allErrors ?? true,
    strict: false,
  });

  // Eagerly kick off the async import when formats are enabled, but don't block
  if (options?.formats !== false) {
    loadFormats().then((addFormats) => {
      if (addFormats) {
        addFormats(ajv);
      }
    });
  }

  return {
    validate(schema: JsonSchema, params: unknown): { valid: boolean; errors: ValidationError[] } {
      const valid = ajv.validate(schema, params);

      if (valid) {
        return { valid: true, errors: [] };
      }

      const errors: ValidationError[] = (ajv.errors ?? []).map((err) => ({
        path: err.instancePath || '(root)',
        message: err.message ?? 'Validation failed',
        suggestion: formatSuggestion(err as {
          keyword: string;
          params: Record<string, unknown>;
          instancePath: string;
        }),
      }));

      return { valid: false, errors };
    },
  };
}
