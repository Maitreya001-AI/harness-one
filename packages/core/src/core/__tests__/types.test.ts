import { describe, it, expect } from 'vitest';
import type { JsonSchema, JsonSchemaType } from '../types.js';

describe('JsonSchema type', () => {
  describe('type field accepts valid JSON Schema types', () => {
    const validTypes: JsonSchemaType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];

    it.each(validTypes)('accepts type "%s"', (type) => {
      const schema: JsonSchema = { type };
      expect(schema.type).toBe(type);
    });
  });

  describe('explicit optional fields replace index signature', () => {
    it('accepts minimum and maximum for number schemas', () => {
      const schema: JsonSchema = {
        type: 'number',
        minimum: 0,
        maximum: 100,
      };
      expect(schema.minimum).toBe(0);
      expect(schema.maximum).toBe(100);
    });

    it('accepts minLength and maxLength for string schemas', () => {
      const schema: JsonSchema = {
        type: 'string',
        minLength: 1,
        maxLength: 255,
      };
      expect(schema.minLength).toBe(1);
      expect(schema.maxLength).toBe(255);
    });

    it('accepts pattern for string schemas', () => {
      const schema: JsonSchema = {
        type: 'string',
        pattern: '^[A-Z]+$',
      };
      expect(schema.pattern).toBe('^[A-Z]+$');
    });

    it('accepts additionalProperties as boolean', () => {
      const schema: JsonSchema = {
        type: 'object',
        additionalProperties: false,
      };
      expect(schema.additionalProperties).toBe(false);
    });

    it('accepts additionalProperties as JsonSchema', () => {
      const schema: JsonSchema = {
        type: 'object',
        additionalProperties: { type: 'string' },
      };
      expect(schema.additionalProperties).toEqual({ type: 'string' });
    });

    it('accepts oneOf', () => {
      const schema: JsonSchema = {
        type: 'object',
        oneOf: [
          { type: 'string' },
          { type: 'number' },
        ],
      };
      expect(schema.oneOf).toHaveLength(2);
    });

    it('accepts anyOf', () => {
      const schema: JsonSchema = {
        type: 'object',
        anyOf: [
          { type: 'string' },
          { type: 'boolean' },
        ],
      };
      expect(schema.anyOf).toHaveLength(2);
    });

    it('accepts allOf', () => {
      const schema: JsonSchema = {
        type: 'object',
        allOf: [
          { type: 'object', properties: { name: { type: 'string' } } },
          { type: 'object', properties: { age: { type: 'number' } } },
        ],
      };
      expect(schema.allOf).toHaveLength(2);
    });

    it('accepts const', () => {
      const schema: JsonSchema = {
        type: 'string',
        const: 'fixed_value',
      };
      expect(schema.const).toBe('fixed_value');
    });

    it('accepts format', () => {
      const schema: JsonSchema = {
        type: 'string',
        format: 'email',
      };
      expect(schema.format).toBe('email');
    });

    it('supports full complex schema', () => {
      const schema: JsonSchema = {
        type: 'object',
        description: 'A user object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          age: { type: 'integer', minimum: 0, maximum: 150 },
          email: { type: 'string', format: 'email', pattern: '^.+@.+\\..+$' },
          tags: { type: 'array', items: { type: 'string' } },
          role: { type: 'string', enum: ['admin', 'user'] },
        },
        required: ['name', 'email'],
        additionalProperties: false,
      };
      expect(schema.type).toBe('object');
      expect(schema.required).toContain('name');
    });
  });
});
