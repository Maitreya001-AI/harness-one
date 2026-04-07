import { describe, it, expect } from 'vitest';
import { createAjvValidator } from '../index.js';

describe('createAjvValidator', () => {
  it('validates a correct object', () => {
    const validator = createAjvValidator({ formats: false });
    const result = validator.validate(
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      },
      { name: 'Alice', age: 30 },
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects an invalid object with correct error details', () => {
    const validator = createAjvValidator({ formats: false });
    const result = validator.validate(
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      },
      { age: 'not-a-number' },
    );

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    // Should have a 'required' error for missing 'name'
    const requiredError = result.errors.find((e) => e.message.includes('required'));
    expect(requiredError).toBeDefined();
    expect(requiredError!.suggestion).toContain('name');
  });

  it('validates enum values', () => {
    const validator = createAjvValidator({ formats: false });
    const schema = {
      type: 'object',
      properties: {
        color: { type: 'string', enum: ['red', 'blue', 'green'] },
      },
      required: ['color'],
    };

    expect(validator.validate(schema, { color: 'red' }).valid).toBe(true);

    const invalid = validator.validate(schema, { color: 'purple' });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors[0].suggestion).toContain('allowed values');
  });

  it('validates type mismatches', () => {
    const validator = createAjvValidator({ formats: false });
    const result = validator.validate(
      { type: 'object', properties: { count: { type: 'number' } } },
      { count: 'not-a-number' },
    );

    expect(result.valid).toBe(false);
    const typeError = result.errors.find((e) => e.suggestion?.includes('type'));
    expect(typeError).toBeDefined();
  });

  it('reports all errors when allErrors is true', () => {
    const validator = createAjvValidator({ allErrors: true, formats: false });
    const result = validator.validate(
      {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
      {},
    );

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2); // Both 'a' and 'b' are missing
  });

  it('validates nested objects', () => {
    const validator = createAjvValidator({ formats: false });
    const schema = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            zip: { type: 'string' },
          },
          required: ['city'],
        },
      },
    };

    expect(validator.validate(schema, { address: { city: 'NYC' } }).valid).toBe(true);
    expect(validator.validate(schema, { address: { zip: '10001' } }).valid).toBe(false);
  });

  it('validates arrays', () => {
    const validator = createAjvValidator({ formats: false });
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
      },
    };

    expect(validator.validate(schema, { tags: ['a', 'b'] }).valid).toBe(true);
    expect(validator.validate(schema, { tags: [1, 2] }).valid).toBe(false);
  });

  it('validates oneOf schemas', () => {
    const validator = createAjvValidator({ formats: false });
    const schema = {
      type: 'object',
      properties: {
        value: {
          oneOf: [
            { type: 'string' },
            { type: 'number' },
          ],
        },
      },
    };

    expect(validator.validate(schema, { value: 'hello' }).valid).toBe(true);
    expect(validator.validate(schema, { value: 42 }).valid).toBe(true);
    expect(validator.validate(schema, { value: true }).valid).toBe(false);
  });

  it('handles empty schema (accepts anything)', () => {
    const validator = createAjvValidator({ formats: false });
    expect(validator.validate({} as any, { anything: true }).valid).toBe(true);
    expect(validator.validate({} as any, 'string').valid).toBe(true);
    expect(validator.validate({} as any, 42).valid).toBe(true);
  });

  it('provides suggestion for unknown keyword errors', () => {
    const validator = createAjvValidator({ formats: false });
    const result = validator.validate(
      { type: 'string', minLength: 5 },
      'hi',
    );

    expect(result.valid).toBe(false);
    expect(result.errors[0].suggestion).toBeDefined();
  });
});
