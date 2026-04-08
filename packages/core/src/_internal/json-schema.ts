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
}

/**
 * Validate data against a JSON Schema (supported subset).
 *
 * @example
 * ```ts
 * const result = validateJsonSchema({ type: 'string' }, 'hello');
 * // { valid: true, errors: [] }
 * ```
 *
 * @example
 * ```ts
 * const result = validateJsonSchema(
 *   { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
 *   {}
 * );
 * // { valid: false, errors: [{ path: '.name', message: 'Property "name" is required' }] }
 * ```
 */
export function validateJsonSchema(
  schema: object,
  data: unknown,
): ValidationResult {
  const errors: ValidationError[] = [];
  validate(schema as SchemaObject, data, '', errors);
  return { valid: errors.length === 0, errors };
}

// Reject patterns with nested quantifiers (ReDoS risk)
function isSafePattern(pattern: string): boolean {
  return !/([+*]|\{\d+,?\d*\})\)([+*]|\{\d+,?\d*\})/.test(pattern);
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
      if (!isSafePattern(schema.pattern)) {
        errors.push({ path, message: 'Pattern rejected: potential ReDoS' });
      } else {
        const re = new RegExp(schema.pattern);
        if (!re.test(data)) {
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
    // Required fields
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in data) || (data as Record<string, unknown>)[key] === undefined) {
          errors.push({ path: `${path}.${key}`, message: `Property "${key}" is required` });
        }
      }
    }
    // Property schemas
    if (schema.properties) {
      const obj = data as Record<string, unknown>;
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj && obj[key] !== undefined) {
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
  if (a === null && b === null) return true;
  return a === b;
}
