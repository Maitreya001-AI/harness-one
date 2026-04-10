import { describe, it, expect } from 'vitest';
import { validateJsonSchema } from '../json-schema.js';

describe('validateJsonSchema', () => {
  // ─── Type validation ───────────────────────────────────────

  describe('type: string', () => {
    const schema = { type: 'string' };

    it('accepts a string', () => {
      expect(validateJsonSchema(schema, 'hello')).toEqual({ valid: true, errors: [] });
    });

    it('accepts empty string', () => {
      expect(validateJsonSchema(schema, '')).toEqual({ valid: true, errors: [] });
    });

    it('rejects number', () => {
      const result = validateJsonSchema(schema, 42);
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('');
      expect(result.errors[0].message).toContain('string');
    });

    it('rejects null', () => {
      expect(validateJsonSchema(schema, null).valid).toBe(false);
    });
  });

  describe('type: number', () => {
    const schema = { type: 'number' };

    it('accepts integer', () => {
      expect(validateJsonSchema(schema, 42)).toEqual({ valid: true, errors: [] });
    });

    it('accepts float', () => {
      expect(validateJsonSchema(schema, 3.14)).toEqual({ valid: true, errors: [] });
    });

    it('accepts 0', () => {
      expect(validateJsonSchema(schema, 0)).toEqual({ valid: true, errors: [] });
    });

    it('accepts negative', () => {
      expect(validateJsonSchema(schema, -1)).toEqual({ valid: true, errors: [] });
    });

    it('rejects string', () => {
      expect(validateJsonSchema(schema, '42').valid).toBe(false);
    });

    it('rejects NaN', () => {
      expect(validateJsonSchema(schema, NaN).valid).toBe(false);
    });
  });

  describe('type: integer', () => {
    const schema = { type: 'integer' };

    it('accepts integer', () => {
      expect(validateJsonSchema(schema, 42)).toEqual({ valid: true, errors: [] });
    });

    it('rejects float', () => {
      expect(validateJsonSchema(schema, 3.14).valid).toBe(false);
    });

    it('accepts 0', () => {
      expect(validateJsonSchema(schema, 0)).toEqual({ valid: true, errors: [] });
    });
  });

  describe('type: boolean', () => {
    const schema = { type: 'boolean' };

    it('accepts true', () => {
      expect(validateJsonSchema(schema, true)).toEqual({ valid: true, errors: [] });
    });

    it('accepts false', () => {
      expect(validateJsonSchema(schema, false)).toEqual({ valid: true, errors: [] });
    });

    it('rejects 0', () => {
      expect(validateJsonSchema(schema, 0).valid).toBe(false);
    });
  });

  describe('type: null', () => {
    const schema = { type: 'null' };

    it('accepts null', () => {
      expect(validateJsonSchema(schema, null)).toEqual({ valid: true, errors: [] });
    });

    it('rejects undefined', () => {
      expect(validateJsonSchema(schema, undefined).valid).toBe(false);
    });

    it('rejects 0', () => {
      expect(validateJsonSchema(schema, 0).valid).toBe(false);
    });
  });

  describe('type: array', () => {
    const schema = { type: 'array' };

    it('accepts empty array', () => {
      expect(validateJsonSchema(schema, [])).toEqual({ valid: true, errors: [] });
    });

    it('accepts array with items', () => {
      expect(validateJsonSchema(schema, [1, 2, 3])).toEqual({ valid: true, errors: [] });
    });

    it('rejects object', () => {
      expect(validateJsonSchema(schema, {}).valid).toBe(false);
    });

    it('rejects null', () => {
      expect(validateJsonSchema(schema, null).valid).toBe(false);
    });
  });

  describe('type: object', () => {
    const schema = { type: 'object' };

    it('accepts empty object', () => {
      expect(validateJsonSchema(schema, {})).toEqual({ valid: true, errors: [] });
    });

    it('accepts object with properties', () => {
      expect(validateJsonSchema(schema, { a: 1 })).toEqual({ valid: true, errors: [] });
    });

    it('rejects array', () => {
      expect(validateJsonSchema(schema, []).valid).toBe(false);
    });

    it('rejects null', () => {
      expect(validateJsonSchema(schema, null).valid).toBe(false);
    });
  });

  // ─── Properties & required ─────────────────────────────────

  describe('properties', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
    };

    it('accepts valid object', () => {
      expect(validateJsonSchema(schema, { name: 'Alice', age: 30 })).toEqual({ valid: true, errors: [] });
    });

    it('accepts object with extra properties', () => {
      expect(validateJsonSchema(schema, { name: 'Alice', age: 30, extra: true })).toEqual({ valid: true, errors: [] });
    });

    it('rejects invalid property type', () => {
      const result = validateJsonSchema(schema, { name: 42, age: 30 });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('.name');
    });
  });

  describe('required', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    };

    it('accepts when required field is present', () => {
      expect(validateJsonSchema(schema, { name: 'Alice' })).toEqual({ valid: true, errors: [] });
    });

    it('rejects when required field is missing', () => {
      const result = validateJsonSchema(schema, { age: 30 });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('.name');
      expect(result.errors[0].message).toContain('required');
    });

    it('rejects when required field is undefined', () => {
      const result = validateJsonSchema(schema, { name: undefined, age: 30 });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('.name');
    });
  });

  // ─── Nested objects ────────────────────────────────────────

  describe('nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
          required: ['street'],
        },
      },
      required: ['address'],
    };

    it('accepts valid nested object', () => {
      const result = validateJsonSchema(schema, { address: { street: '123 Main St', city: 'NYC' } });
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('rejects invalid nested property', () => {
      const result = validateJsonSchema(schema, { address: { street: 123 } });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('.address.street');
    });

    it('rejects missing nested required field', () => {
      const result = validateJsonSchema(schema, { address: { city: 'NYC' } });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('.address.street');
    });
  });

  // ─── Arrays with items ────────────────────────────────────

  describe('items', () => {
    const schema = {
      type: 'array',
      items: { type: 'number' },
    };

    it('accepts valid array items', () => {
      expect(validateJsonSchema(schema, [1, 2, 3])).toEqual({ valid: true, errors: [] });
    });

    it('accepts empty array', () => {
      expect(validateJsonSchema(schema, [])).toEqual({ valid: true, errors: [] });
    });

    it('rejects invalid array item', () => {
      const result = validateJsonSchema(schema, [1, 'two', 3]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('[1]');
    });

    it('validates array of objects', () => {
      const objArraySchema = {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'number' } },
          required: ['id'],
        },
      };
      expect(validateJsonSchema(objArraySchema, [{ id: 1 }, { id: 2 }])).toEqual({ valid: true, errors: [] });

      const result = validateJsonSchema(objArraySchema, [{ id: 1 }, {}]);
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('[1].id');
    });
  });

  // ─── Enum ─────────────────────────────────────────────────

  describe('enum', () => {
    const schema = { enum: ['red', 'green', 'blue'] };

    it('accepts valid enum value', () => {
      expect(validateJsonSchema(schema, 'red')).toEqual({ valid: true, errors: [] });
    });

    it('rejects invalid enum value', () => {
      const result = validateJsonSchema(schema, 'yellow');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('enum');
    });

    it('supports numeric enums', () => {
      const numSchema = { enum: [1, 2, 3] };
      expect(validateJsonSchema(numSchema, 2)).toEqual({ valid: true, errors: [] });
      expect(validateJsonSchema(numSchema, 4).valid).toBe(false);
    });

    it('supports null in enum', () => {
      const nullSchema = { enum: ['a', null] };
      expect(validateJsonSchema(nullSchema, null)).toEqual({ valid: true, errors: [] });
    });

    it('supports object values in enum', () => {
      const objSchema = { enum: [{ a: 1 }, { b: 2 }] };
      expect(validateJsonSchema(objSchema, { a: 1 })).toEqual({ valid: true, errors: [] });
      expect(validateJsonSchema(objSchema, { c: 3 }).valid).toBe(false);
    });

    it('supports array values in enum', () => {
      const arrSchema = { enum: [[1, 2], [3, 4]] };
      expect(validateJsonSchema(arrSchema, [1, 2])).toEqual({ valid: true, errors: [] });
      expect(validateJsonSchema(arrSchema, [5, 6]).valid).toBe(false);
    });

    it('supports nested object values in enum', () => {
      const nestedSchema = { enum: [{ a: { b: { c: 1 } } }, { x: [1, 2] }] };
      expect(validateJsonSchema(nestedSchema, { a: { b: { c: 1 } } })).toEqual({ valid: true, errors: [] });
      expect(validateJsonSchema(nestedSchema, { x: [1, 2] })).toEqual({ valid: true, errors: [] });
      expect(validateJsonSchema(nestedSchema, { a: { b: { c: 2 } } }).valid).toBe(false);
    });
  });

  // ─── Pattern ──────────────────────────────────────────────

  describe('pattern', () => {
    const schema = { type: 'string', pattern: '^[A-Z]+$' };

    it('accepts matching string', () => {
      expect(validateJsonSchema(schema, 'HELLO')).toEqual({ valid: true, errors: [] });
    });

    it('rejects non-matching string', () => {
      const result = validateJsonSchema(schema, 'hello');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('pattern');
    });

    it('skips pattern check for non-strings', () => {
      // type check will fail first, pattern should not cause additional confusing error
      const result = validateJsonSchema(schema, 42);
      expect(result.valid).toBe(false);
    });
  });

  // ─── Minimum / Maximum ────────────────────────────────────

  describe('minimum / maximum', () => {
    const schema = { type: 'number', minimum: 0, maximum: 100 };

    it('accepts value within range', () => {
      expect(validateJsonSchema(schema, 50)).toEqual({ valid: true, errors: [] });
    });

    it('accepts boundary values', () => {
      expect(validateJsonSchema(schema, 0)).toEqual({ valid: true, errors: [] });
      expect(validateJsonSchema(schema, 100)).toEqual({ valid: true, errors: [] });
    });

    it('rejects value below minimum', () => {
      const result = validateJsonSchema(schema, -1);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('minimum');
    });

    it('rejects value above maximum', () => {
      const result = validateJsonSchema(schema, 101);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('maximum');
    });
  });

  // ─── minLength / maxLength ────────────────────────────────

  describe('minLength / maxLength', () => {
    const schema = { type: 'string', minLength: 2, maxLength: 5 };

    it('accepts string within length bounds', () => {
      expect(validateJsonSchema(schema, 'abc')).toEqual({ valid: true, errors: [] });
    });

    it('accepts boundary lengths', () => {
      expect(validateJsonSchema(schema, 'ab')).toEqual({ valid: true, errors: [] });
      expect(validateJsonSchema(schema, 'abcde')).toEqual({ valid: true, errors: [] });
    });

    it('rejects string below minLength', () => {
      const result = validateJsonSchema(schema, 'a');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('minLength');
    });

    it('rejects string above maxLength', () => {
      const result = validateJsonSchema(schema, 'abcdef');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('maxLength');
    });
  });

  // ─── Fix 9: ReDoS Protection ──────────────────────────────

  describe('Fix 9: ReDoS protection', () => {
    it('rejects malformed regex patterns gracefully instead of throwing', () => {
      const schema = { type: 'string', pattern: '(unclosed' };
      const result = validateJsonSchema(schema, 'test');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('invalid regular expression');
    });

    it('rejects patterns exceeding max length', () => {
      const longPattern = 'a'.repeat(1001);
      const schema = { type: 'string', pattern: longPattern };
      const result = validateJsonSchema(schema, 'test');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('exceeds maximum length');
    });

    it('rejects alternation overlap patterns like (a|a)*', () => {
      const schema = { type: 'string', pattern: '(a|a)*' };
      const result = validateJsonSchema(schema, 'aaa');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('ReDoS');
    });

    it('rejects nested quantifier patterns like (a+)+', () => {
      const schema = { type: 'string', pattern: '(a+)+' };
      const result = validateJsonSchema(schema, 'aaa');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('ReDoS');
    });

    it('rejects patterns with quantified groups containing quantifiers like (a*)*', () => {
      const schema = { type: 'string', pattern: '(a*)*' };
      const result = validateJsonSchema(schema, 'aaa');
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('ReDoS');
    });

    it('accepts safe patterns normally', () => {
      const schema = { type: 'string', pattern: '^[a-z]+$' };
      const result = validateJsonSchema(schema, 'hello');
      expect(result.valid).toBe(true);
    });

    it('handles pattern with exactly 1000 chars (boundary)', () => {
      const pattern = '^' + 'a'.repeat(998) + '$';
      const schema = { type: 'string', pattern };
      // Should not reject for length (exactly 1000 is allowed)
      const result = validateJsonSchema(schema, 'test');
      // Pattern won't match, but it shouldn't be rejected for length
      expect(result.errors.every(e => !e.message.includes('exceeds maximum length'))).toBe(true);
    });
  });

  // ─── Edge cases ───────────────────────────────────────────

  describe('edge cases', () => {
    it('validates with empty schema (accepts anything)', () => {
      expect(validateJsonSchema({}, 'anything')).toEqual({ valid: true, errors: [] });
      expect(validateJsonSchema({}, null)).toEqual({ valid: true, errors: [] });
      expect(validateJsonSchema({}, 42)).toEqual({ valid: true, errors: [] });
    });

    it('collects multiple errors', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'age'],
      };
      const result = validateJsonSchema(schema, {});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(2);
    });

    it('handles deeply nested structures', () => {
      const schema = {
        type: 'object',
        properties: {
          level1: {
            type: 'object',
            properties: {
              level2: {
                type: 'object',
                properties: {
                  value: { type: 'number' },
                },
              },
            },
          },
        },
      };
      const result = validateJsonSchema(schema, { level1: { level2: { value: 'not a number' } } });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('.level1.level2.value');
    });

    it('combined constraints: type + enum + pattern', () => {
      const schema = { type: 'string', enum: ['YES', 'NO'], pattern: '^[A-Z]+$' };
      expect(validateJsonSchema(schema, 'YES')).toEqual({ valid: true, errors: [] });
      expect(validateJsonSchema(schema, 'MAYBE').valid).toBe(false);
    });
  });
});
