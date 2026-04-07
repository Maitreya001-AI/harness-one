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
});
