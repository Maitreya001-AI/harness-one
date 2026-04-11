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
 * The return type of createAjvValidator: a SchemaValidator whose validate()
 * method returns a Promise so callers can await it to guarantee formats are
 * applied before validation runs (fixing the race condition).
 *
 * The SchemaValidator interface supports both sync and async validate().
 * AjvSchemaValidator narrows the return to always be a Promise.
 */
export type AjvSchemaValidator = Omit<SchemaValidator, 'validate'> & {
  validate(schema: JsonSchema, params: unknown): Promise<{ valid: boolean; errors: ValidationError[] }>;
};

/**
 * Create a SchemaValidator backed by Ajv, supporting full JSON Schema draft-07+.
 *
 * This replaces the built-in lightweight validator when you need:
 * - $ref / $defs for schema composition
 * - oneOf / anyOf / allOf combinators
 * - String formats (email, uri, date-time, etc.) when ajv-formats is installed
 * - Custom keywords and vocabularies
 *
 * Format loading race condition fix: the factory tracks a `formatsLoaded` promise
 * that resolves once ajv-formats has been applied to the Ajv instance. The `validate`
 * method is async so callers MUST `await` it to guarantee formats are applied before
 * validation runs. Remove any `setTimeout` workarounds from calling code.
 */
export function createAjvValidator(options?: AjvValidatorOptions): AjvSchemaValidator {
  const ajv = new Ajv({
    allErrors: options?.allErrors ?? true,
    strict: false,
  });

  // Track the formats loading promise so validate() can await it on first call.
  let formatsLoaded: Promise<void> | undefined;

  if (options?.formats !== false) {
    formatsLoaded = loadFormats().then((addFormats) => {
      if (addFormats) {
        addFormats(ajv);
      }
    });
  }

  return {
    async validate(schema: JsonSchema, params: unknown): Promise<{ valid: boolean; errors: ValidationError[] }> {
      // Await formats exactly once to eliminate the race condition where validate()
      // is called before the ajv-formats dynamic import has resolved.
      if (formatsLoaded) {
        await formatsLoaded;
        formatsLoaded = undefined; // Only await once; subsequent calls skip this
      }

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
