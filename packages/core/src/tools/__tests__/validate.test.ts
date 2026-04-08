import { describe, it, expect } from 'vitest';
import { validateToolCall } from '../validate.js';
import type { JsonSchema } from '../../core/types.js';

describe('validateToolCall', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
    },
    required: ['name'],
  };

  it('returns valid for correct params', () => {
    const result = validateToolCall(schema, { name: 'Alice', age: 30 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns errors for missing required field', () => {
    const result = validateToolCall(schema, { age: 30 });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].path).toContain('name');
  });

  it('returns errors for wrong type', () => {
    const result = validateToolCall(schema, { name: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toContain('name');
  });

  it('validates nested objects', () => {
    const nested: JsonSchema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { email: { type: 'string' } },
          required: ['email'],
        },
      },
      required: ['user'],
    };
    const result = validateToolCall(nested, { user: {} });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toContain('email');
  });

  it('returns valid for empty schema', () => {
    const result = validateToolCall({ type: 'object' }, {});
    expect(result.valid).toBe(true);
  });

  describe('edge cases', () => {
    it('validate with nested object schema', () => {
      const nestedSchema: JsonSchema = {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            properties: {
              street: { type: 'string' },
              city: { type: 'string' },
              zip: { type: 'string' },
            },
            required: ['street', 'city'],
          },
        },
        required: ['address'],
      };
      // Valid nested object
      const valid = validateToolCall(nestedSchema, {
        address: { street: '123 Main', city: 'Springfield', zip: '12345' },
      });
      expect(valid.valid).toBe(true);

      // Missing nested required field
      const invalid = validateToolCall(nestedSchema, {
        address: { street: '123 Main' },
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.some(e => e.path.includes('city'))).toBe(true);

      // Missing top-level required field
      const missingTop = validateToolCall(nestedSchema, {});
      expect(missingTop.valid).toBe(false);
      expect(missingTop.errors.some(e => e.path.includes('address'))).toBe(true);
    });

    it('validate with array items', () => {
      const arraySchema: JsonSchema = {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['tags'],
      };
      // Valid array
      const valid = validateToolCall(arraySchema, { tags: ['a', 'b', 'c'] });
      expect(valid.valid).toBe(true);

      // Invalid array item type
      const invalid = validateToolCall(arraySchema, { tags: ['a', 123, 'c'] });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.length).toBeGreaterThan(0);
    });

    it('validate with enum constraints', () => {
      const enumSchema: JsonSchema = {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'inactive', 'pending'],
          },
        },
        required: ['status'],
      };
      // Valid enum value
      const valid = validateToolCall(enumSchema, { status: 'active' });
      expect(valid.valid).toBe(true);

      // Invalid enum value
      const invalid = validateToolCall(enumSchema, { status: 'deleted' });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.some(e => e.message.includes('enum'))).toBe(true);
    });

    it('validate with missing required fields', () => {
      const multiRequired: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'email', 'age'],
      };
      // Missing all required fields
      const result = validateToolCall(multiRequired, {});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(3);
      expect(result.errors.some(e => e.path.includes('name'))).toBe(true);
      expect(result.errors.some(e => e.path.includes('email'))).toBe(true);
      expect(result.errors.some(e => e.path.includes('age'))).toBe(true);
    });
  });
});
