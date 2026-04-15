/**
 * Minimal JSON Schema validator for harness-one internal use.
 *
 * Supported subset: type, properties, required, items, enum, pattern,
 * minimum/maximum, minLength/maxLength.
 *
 * NOT supported: $ref, oneOf/anyOf/allOf, additionalProperties, if/then/else,
 * format, recursive schemas.
 *
 * @module
 */

import { LRUCache } from './lru-cache.js';

/**
 * CQ-018: Module-level bounded LRU cache for compiled RegExp instances,
 * keyed by the pattern string. Prevents repeatedly recompiling the same
 * pattern across validate() calls. Size is bounded to avoid unbounded
 * growth when many unique patterns are encountered.
 *
 * A cached value of `null` means the pattern was previously rejected
 * (invalid regex) — we remember that so repeated attempts don't re-throw.
 */
const REGEX_CACHE_MAX = 256;
const regexCache = new LRUCache<string, RegExp | null>(REGEX_CACHE_MAX);

function getCompiledPattern(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) {
    return regexCache.get(pattern) ?? null;
  }
  try {
    const re = new RegExp(pattern);
    regexCache.set(pattern, re);
    return re;
  } catch {
    regexCache.set(pattern, null);
    return null;
  }
}

interface SchemaObject {
  type?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  [key: string]: unknown;
}

interface ValidationError {
  path: string;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /** Keywords present in the schema that are not evaluated by this validator. */
  warnings: string[];
}

/**
 * JSON Schema keywords that this validator does not evaluate.
 * Their presence in a schema is silently ignored during validation, which can
 * lead to false-positive "valid" results.  We surface them as warnings so
 * callers are aware that their schemas may not be fully enforced.
 */
const UNSUPPORTED_KEYWORDS = [
  '$ref',
  '$defs',
  'allOf',
  'anyOf',
  'oneOf',
  'if',
  'then',
  'else',
  'additionalProperties',
  'not',
] as const;

/**
 * Property names that must never be used as schema property keys because they
 * can pollute `Object.prototype` when accessed via unchecked `key in obj` or
 * `obj[key]` lookups. We reject these defensively (SEC-004).
 */
const DANGEROUS_PROP_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Safe property lookup that avoids traversing the prototype chain.
 * Returns `true` only when `key` is defined as an own, enumerable property.
 */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Recursively walk a schema object and collect any unsupported keyword names.
 * Each unique keyword is reported at most once regardless of how many times it
 * appears in the schema tree.
 *
 * Skips keys that are not own-properties (protects against prototype pollution)
 * and emits a warning for dangerous property names (`__proto__`, `constructor`,
 * `prototype`).
 */
function detectUnsupportedKeywords(schema: Record<string, unknown>): string[] {
  const found = new Set<string>();

  function walk(obj: Record<string, unknown>): void {
    for (const key of Object.keys(obj)) {
      if (!hasOwn(obj, key)) continue;
      if (DANGEROUS_PROP_NAMES.has(key)) {
        found.add(`unsafe-property:${key}`);
        continue;
      }
      if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
        found.add(key);
      }
      const value = obj[key];
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        walk(value as Record<string, unknown>);
      }
    }
  }

  walk(schema);
  return Array.from(found);
}

/**
 * Validate data against a JSON Schema (supported subset).
 *
 * Returns `{ valid, errors, warnings }`.  `warnings` lists any schema keywords
 * that are present but NOT evaluated by this validator (e.g. `$ref`, `allOf`).
 * A non-empty `warnings` array does not affect `valid`, but callers should be
 * aware that the data has not been checked against those constraints.
 *
 * @example
 * ```ts
 * const result = validateJsonSchema({ type: 'string' }, 'hello');
 * // { valid: true, errors: [], warnings: [] }
 * ```
 *
 * @example
 * ```ts
 * const result = validateJsonSchema(
 *   { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
 *   {}
 * );
 * // { valid: false, errors: [{ path: '.name', message: 'Property "name" is required' }], warnings: [] }
 * ```
 */
export function validateJsonSchema(
  schema: object,
  data: unknown,
): ValidationResult {
  const errors: ValidationError[] = [];
  validate(schema as SchemaObject, data, '', errors);
  const warnings = detectUnsupportedKeywords(schema as Record<string, unknown>);
  return { valid: errors.length === 0, errors, warnings };
}

/** Maximum allowed regex pattern length to prevent DoS. */
const MAX_PATTERN_LENGTH = 1000;

/**
 * Reject regex patterns that risk catastrophic backtracking (ReDoS).
 * Catches: nested quantifiers like (a+)+, alternation overlaps like (a|a)*,
 * deeply nested groups with quantifiers, and overly long patterns.
 */
function isSafePattern(pattern: string): boolean {
  // Length limit as a simple safety measure
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  // Nested quantifiers: (...)+ (...)* etc.
  if (/([+*]|\{\d+,?\d*\})\)([+*]|\{\d+,?\d*\})/.test(pattern)) return false;
  // Alternation with quantifier on group: (a|b)+ where alternatives overlap
  if (/\([^)]*\|[^)]*\)[+*]/.test(pattern)) return false;
  // Alternation overlap patterns like (a|a)* — same char on both sides
  if (/\((\w)\|\1\)[+*]/.test(pattern)) return false;
  // Deeply nested groups (3+ levels) with quantifiers
  if (/\([^)]*\([^)]*\([^)]*\)/.test(pattern)) return false;
  // Quantified groups containing quantified elements: (a+)+ or (a*)*
  if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) return false;
  return true;
}

function validate(
  schema: SchemaObject,
  data: unknown,
  path: string,
  errors: ValidationError[],
): void {
  // Enum check (can be standalone without type)
  if (schema.enum !== undefined) {
    if (!schema.enum.some((v) => strictEqual(v, data))) {
      errors.push({ path, message: `Value must be one of enum values: ${JSON.stringify(schema.enum)}` });
      return;
    }
  }

  // Type check
  if (schema.type !== undefined) {
    if (!checkType(schema.type, data)) {
      errors.push({
        path,
        message: `Expected type "${schema.type}" but got "${typeOf(data)}"`,
      });
      return; // No point checking further constraints if type is wrong
    }
  }

  // String constraints
  if (typeof data === 'string') {
    if (schema.pattern !== undefined) {
      if (schema.pattern.length > MAX_PATTERN_LENGTH) {
        errors.push({ path, message: `Pattern rejected: exceeds maximum length (${MAX_PATTERN_LENGTH})` });
      } else if (!isSafePattern(schema.pattern)) {
        errors.push({ path, message: 'Pattern rejected: potential ReDoS' });
      } else {
        // CQ-018: use the module-level LRU cache instead of compiling each call.
        const re = getCompiledPattern(schema.pattern);
        if (re === null) {
          errors.push({ path, message: `Pattern rejected: invalid regular expression "${schema.pattern}"` });
        } else if (!re.test(data)) {
          errors.push({ path, message: `String does not match pattern "${schema.pattern}"` });
        }
      }
    }
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push({ path, message: `String length ${data.length} is less than minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      errors.push({ path, message: `String length ${data.length} exceeds maxLength ${schema.maxLength}` });
    }
  }

  // Number constraints
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push({ path, message: `Value ${data} is less than minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push({ path, message: `Value ${data} exceeds maximum ${schema.maximum}` });
    }
  }

  // Object constraints
  if (isPlainObject(data)) {
    const obj = data as Record<string, unknown>;
    // Required fields — use hasOwn to avoid prototype-chain lookups (SEC-004)
    if (schema.required) {
      for (const key of schema.required) {
        if (DANGEROUS_PROP_NAMES.has(key)) {
          // Dangerous key names are never enforced; silently skip
          continue;
        }
        if (!hasOwn(obj, key) || obj[key] === undefined) {
          errors.push({ path: `${path}.${key}`, message: `Property "${key}" is required` });
        }
      }
    }
    // Property schemas — iterate schema's own keys only, skipping dangerous names
    if (schema.properties) {
      for (const key of Object.keys(schema.properties)) {
        if (!hasOwn(schema.properties, key)) continue;
        if (DANGEROUS_PROP_NAMES.has(key)) continue;
        const propSchema = schema.properties[key];
        if (hasOwn(obj, key) && obj[key] !== undefined) {
          validate(propSchema, obj[key], `${path}.${key}`, errors);
        }
      }
    }
  }

  // Array constraints
  if (Array.isArray(data) && schema.items) {
    for (let i = 0; i < data.length; i++) {
      validate(schema.items, data[i], `${path}[${i}]`, errors);
    }
  }
}

function checkType(type: string, data: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof data === 'string';
    case 'number':
      return typeof data === 'number' && !Number.isNaN(data);
    case 'integer':
      return typeof data === 'number' && Number.isInteger(data);
    case 'boolean':
      return typeof data === 'boolean';
    case 'null':
      return data === null;
    case 'array':
      return Array.isArray(data);
    case 'object':
      return isPlainObject(data);
    default:
      return false;
  }
}

function isPlainObject(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data);
}

function typeOf(data: unknown): string {
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'array';
  if (typeof data === 'number' && Number.isNaN(data)) return 'NaN';
  return typeof data;
}

function strictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => strictEqual(v, b[i]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k => strictEqual(aObj[k], bObj[k]));
  }

  return false;
}
