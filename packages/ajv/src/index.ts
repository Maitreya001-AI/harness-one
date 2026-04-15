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

import { Ajv, type ValidateFunction } from 'ajv';
import type { JsonSchema } from 'harness-one/core';
import type { SchemaValidator, ValidationError } from 'harness-one/tools';
import type { Logger } from 'harness-one/observe';
import { createDefaultLogger } from 'harness-one/observe';

/** Options for the Ajv validator. */
export interface AjvValidatorOptions {
  /** Report all errors instead of stopping at the first one. Defaults to true. */
  readonly allErrors?: boolean;
  /** Enable format validators (email, uri, date-time, etc.). Defaults to true. */
  readonly formats?: boolean;
  /**
   * Maximum number of compiled-validator entries to keep in the LRU cache.
   * Past this size, least-recently-used entries are evicted and their
   * underlying Ajv schemas removed to bound memory growth. Defaults to 256.
   */
  readonly maxCacheSize?: number;
  /**
   * Optional logger used for non-fatal adapter warnings. Defaults to the
   * global `console`. Library code SHOULD NOT write directly to `console` —
   * accept a logger so hosts can route/silence warnings.
   */
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
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
      .catch(() => {
        // Reset so next call retries the import (transient failures shouldn't be cached)
        formatsLoader = undefined;
        return null;
      });
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
 * Stable, low-collision hash of a JSON schema for LRU cache keying.
 *
 * We use a simple polynomial rolling hash (djb2-variant) over the canonical
 * JSON serialisation. Collision resistance does not need to be cryptographic
 * — we only need two schemas that serialise to the same string to map to the
 * same validator, which is the desired reuse behaviour. We include a length
 * suffix to further reduce accidental collisions between short inputs.
 */
function stableSchemaKey(schema: JsonSchema): string {
  let str: string;
  try {
    str = JSON.stringify(schema);
  } catch {
    // Circular or otherwise unserialisable schemas — fall back to
    // reference identity via a per-call unique key so we don't crash,
    // at the cost of no cache reuse for that call.
    return `__unserializable_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  }
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // (hash * 33) ^ c, kept in 32-bit range
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  // Unsigned hex + length guards against short-string collisions.
  return `s_${(hash >>> 0).toString(36)}_${str.length}`;
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
 * Format loading race condition fix: the factory tracks a `formatsLoaded` promise
 * that resolves once ajv-formats has been applied to the Ajv instance. The `validate`
 * method is async so callers MUST `await` it to guarantee formats are applied before
 * validation runs. Remove any `setTimeout` workarounds from calling code.
 *
 * Bounded schema cache (CQ-020): compiled validators are cached in an LRU map
 * keyed on a stable hash of the schema JSON. When the cache exceeds
 * `maxCacheSize` (default 256), the least-recently-used entry is evicted and
 * removed from the underlying Ajv instance to release the associated memory.
 */
export function createAjvValidator(options?: AjvValidatorOptions): AjvSchemaValidator {
  const ajv = new Ajv({
    allErrors: options?.allErrors ?? true,
    strict: false,
  });

  const maxCacheSize = Math.max(1, options?.maxCacheSize ?? 256);
  // Wave-5F T13: delegate default logger to core's redaction-enabled singleton.
  const logger: Pick<Logger, 'warn' | 'error'> = options?.logger ?? createDefaultLogger();

  /**
   * LRU cache of compiled validators. Map iteration order is insertion order,
   * so to mark an entry as "most recently used" we delete and re-insert it on
   * every hit. Eviction: when size exceeds maxCacheSize, drop the oldest key
   * (`cache.keys().next().value`) and remove the schema from Ajv to free
   * its compiled code.
   */
  const cache = new Map<string, ValidateFunction>();

  // Track the formats loading promise so validate() can await it on first call.
  let formatsLoaded: Promise<void> | undefined;

  if (options?.formats !== false) {
    formatsLoaded = loadFormats().then((addFormats) => {
      if (addFormats) {
        addFormats(ajv);
      }
    });
  }

  function compileWithCache(schema: JsonSchema): ValidateFunction {
    const key = stableSchemaKey(schema);

    // Cache hit — bump to most-recently-used by re-inserting.
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }

    // Cache miss — compile and attach an $id so we can ajv.removeSchema on evict.
    const taggedSchema = { ...schema, $id: key } as JsonSchema & { $id: string };
    let validator: ValidateFunction;
    try {
      validator = ajv.compile(taggedSchema);
    } catch (err) {
      // Don't poison the cache with an uncompilable schema.
      logger.warn(
        '[harness-one/ajv] compile() failed; schema will not be cached.',
        { error: err instanceof Error ? err.message : String(err) },
      );
      throw err;
    }
    cache.set(key, validator);

    // Evict LRU entries until we're back within budget.
    while (cache.size > maxCacheSize) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
      try {
        ajv.removeSchema(oldestKey);
      } catch {
        // removeSchema throws if the schema wasn't registered under this id;
        // safe to ignore — the cache entry is already gone.
      }
    }

    return validator;
  }

  return {
    async validate(schema: JsonSchema, params: unknown): Promise<{ valid: boolean; errors: ValidationError[] }> {
      // Await formats exactly once to eliminate the race condition where validate()
      // is called before the ajv-formats dynamic import has resolved.
      if (formatsLoaded) {
        await formatsLoaded;
        formatsLoaded = undefined; // Only await once; subsequent calls skip this
      }

      const validator = compileWithCache(schema);
      const valid = validator(params);

      if (valid) {
        return { valid: true, errors: [] };
      }

      const errors: ValidationError[] = (validator.errors ?? []).map((err) => ({
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
