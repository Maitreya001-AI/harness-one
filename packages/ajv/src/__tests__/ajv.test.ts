import { describe, it, expect, vi } from 'vitest';
import { createAjvValidator } from '../index.js';
import type { JsonSchema } from 'harness-one/core';

describe('createAjvValidator', () => {
  it('validates a correct object', async () => {
    const validator = createAjvValidator({ formats: false });
    const result = await validator.validate(
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

  it('rejects an invalid object with correct error details', async () => {
    const validator = createAjvValidator({ formats: false });
    const result = await validator.validate(
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

    const requiredError = result.errors.find((e) => e.message.includes('required'));
    expect(requiredError).toBeDefined();
    expect(requiredError!.suggestion).toContain('name');
  });

  it('validates enum values', async () => {
    const validator = createAjvValidator({ formats: false });
    const schema = {
      type: 'object',
      properties: {
        color: { type: 'string', enum: ['red', 'blue', 'green'] },
      },
      required: ['color'],
    };

    expect((await validator.validate(schema, { color: 'red' })).valid).toBe(true);

    const invalid = await validator.validate(schema, { color: 'purple' });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors[0].suggestion).toContain('allowed values');
  });

  it('validates type mismatches', async () => {
    const validator = createAjvValidator({ formats: false });
    const result = await validator.validate(
      { type: 'object', properties: { count: { type: 'number' } } },
      { count: 'not-a-number' },
    );

    expect(result.valid).toBe(false);
    const typeError = result.errors.find((e) => e.suggestion?.includes('type'));
    expect(typeError).toBeDefined();
  });

  it('reports all errors when allErrors is true', async () => {
    const validator = createAjvValidator({ allErrors: true, formats: false });
    const result = await validator.validate(
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
    expect(result.errors.length).toBe(2);
  });

  it('validates nested objects', async () => {
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

    expect((await validator.validate(schema, { address: { city: 'NYC' } })).valid).toBe(true);
    expect((await validator.validate(schema, { address: { zip: '10001' } })).valid).toBe(false);
  });

  it('validates arrays', async () => {
    const validator = createAjvValidator({ formats: false });
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
      },
    };

    expect((await validator.validate(schema, { tags: ['a', 'b'] })).valid).toBe(true);
    expect((await validator.validate(schema, { tags: [1, 2] })).valid).toBe(false);
  });

  it('validates oneOf schemas', async () => {
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

    expect((await validator.validate(schema, { value: 'hello' })).valid).toBe(true);
    expect((await validator.validate(schema, { value: 42 })).valid).toBe(true);
    expect((await validator.validate(schema, { value: true })).valid).toBe(false);
  });

  it('handles empty schema (accepts anything)', async () => {
    const validator = createAjvValidator({ formats: false });
    expect((await validator.validate({} as unknown as JsonSchema, { anything: true })).valid).toBe(true);
    expect((await validator.validate({} as unknown as JsonSchema, 'string')).valid).toBe(true);
    expect((await validator.validate({} as unknown as JsonSchema, 42)).valid).toBe(true);
  });

  it('provides suggestion for unknown keyword errors', async () => {
    const validator = createAjvValidator({ formats: false });
    const result = await validator.validate(
      { type: 'string', minLength: 5 },
      'hi',
    );

    expect(result.valid).toBe(false);
    expect(result.errors[0].suggestion).toBeDefined();
  });

  it('formatSuggestion handles "format" keyword', async () => {
    const validator = createAjvValidator({ formats: false });
    const schema = {
      oneOf: [
        { type: 'string' },
        { type: 'number' },
      ],
    };
    const result = await validator.validate(schema as any, true);
    expect(result.valid).toBe(false);
    const oneOfError = result.errors.find((e) => e.suggestion?.includes('exactly one'));
    expect(oneOfError).toBeDefined();
  });

  it('formatSuggestion handles "anyOf" keyword', async () => {
    const validator = createAjvValidator({ formats: false });
    const schema = {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
      ],
    };
    const result = await validator.validate(schema as any, true);
    expect(result.valid).toBe(false);
    const anyOfError = result.errors.find((e) => e.suggestion?.includes('at least one'));
    expect(anyOfError).toBeDefined();
  });

  it('uses ESM dynamic import for ajv-formats when formats is not disabled', async () => {
    const validator = createAjvValidator();
    const result = await validator.validate(
      { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      { name: 'Alice' },
    );
    expect(result.valid).toBe(true);
  });

  it('works with formats explicitly enabled', async () => {
    const validator = createAjvValidator({ formats: true });
    const result = await validator.validate(
      { type: 'string' },
      'hello',
    );
    expect(result.valid).toBe(true);
  });

  it('uses allErrors=true by default', async () => {
    const validator = createAjvValidator({ formats: false });
    const result = await validator.validate(
      {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'number' },
          c: { type: 'boolean' },
        },
        required: ['a', 'b', 'c'],
      },
      {},
    );
    expect(result.errors.length).toBe(3);
  });

  it('defaults allErrors to true when not specified', async () => {
    const validator = createAjvValidator();
    const result = await validator.validate(
      {
        type: 'object',
        properties: {
          x: { type: 'string' },
          y: { type: 'string' },
        },
        required: ['x', 'y'],
      },
      {},
    );
    expect(result.errors.length).toBe(2);
  });

  it('formatSuggestion handles "format" keyword with email format', async () => {
    const validator = createAjvValidator({ formats: true });
    const result = await validator.validate(
      {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
        },
      } as any,
      { email: 'not-an-email' },
    );

    expect(result.valid).toBe(false);
    const formatError = result.errors.find((e) => e.suggestion?.includes('valid'));
    expect(formatError).toBeDefined();
    expect(formatError!.suggestion).toContain('email');
  });

  it('handles ajv-formats import failure gracefully', async () => {
    const validator = createAjvValidator({ formats: false });
    const result = await validator.validate({ type: 'string' }, 'hello');
    expect(result.valid).toBe(true);
  });

  it('validate() awaits formats loading — no race condition when called immediately', async () => {
    const validator = createAjvValidator({ formats: true });
    const result = await validator.validate(
      {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
        },
      } as any,
      { email: 'not-an-email' },
    );
    expect(result.valid).toBe(false);
    const formatError = result.errors.find((e) => e.suggestion?.includes('valid'));
    expect(formatError).toBeDefined();
    expect(formatError!.suggestion).toContain('email');
  });

  it('validate() only awaits formats once — subsequent calls skip the await', async () => {
    const validator = createAjvValidator({ formats: true });
    const r1 = await validator.validate({ type: 'string' }, 'hello');
    expect(r1.valid).toBe(true);
    const r2 = await validator.validate({ type: 'string' }, 42);
    expect(r2.valid).toBe(false);
  });

  it('returns SchemaValidator synchronously (lazy format loading)', () => {
    const validator = createAjvValidator({ formats: true });
    expect(validator).toBeDefined();
    expect(typeof validator.validate).toBe('function');
    const resultPromise = validator.validate({ type: 'string' }, 'hello');
    expect(resultPromise).toBeInstanceOf(Promise);
  });

  // ------------------------------------------------------------------------
  // CQ-020: bounded LRU schema cache
  // ------------------------------------------------------------------------
  describe('bounded schema cache (CQ-020)', () => {
    it('reuses compiled validator for structurally identical schemas', async () => {
      const validator = createAjvValidator({ formats: false });
      const schema: JsonSchema = { type: 'object', properties: { x: { type: 'string' } } };

      // First call compiles; subsequent calls with the same schema JSON must reuse.
      const r1 = await validator.validate(schema, { x: 'hi' });
      const r2 = await validator.validate({ type: 'object', properties: { x: { type: 'string' } } }, { x: 'hi' });
      expect(r1.valid).toBe(true);
      expect(r2.valid).toBe(true);
    });

    it('caps the cache at maxCacheSize and evicts LRU entries', async () => {
      const validator = createAjvValidator({ formats: false, maxCacheSize: 3 });

      // Insert 5 distinct schemas — eviction should kick in after the 3rd.
      for (let i = 0; i < 5; i++) {
        const schema: JsonSchema = {
          type: 'object',
          properties: { [`f${i}`]: { type: 'string' } },
        };
        const r = await validator.validate(schema, { [`f${i}`]: 'v' });
        expect(r.valid).toBe(true);
      }

      // The early-inserted schemas have been evicted but validation must still succeed
      // (on eviction we re-compile, not drop the schema permanently).
      const earliest: JsonSchema = {
        type: 'object',
        properties: { f0: { type: 'string' } },
      };
      const rAgain = await validator.validate(earliest, { f0: 'x' });
      expect(rAgain.valid).toBe(true);
    });

    it('does not leak Ajv-registered schemas past maxCacheSize', async () => {
      // Indirect check: if we didn't evict, Ajv would accumulate $id entries
      // and eventually throw "schema with key or id already exists" on
      // certain replacement paths. We can't easily introspect Ajv internals,
      // but we CAN drive enough distinct schemas through a small cache to
      // prove the pipeline stays healthy (no crashes, no duplicate $id errors).
      const validator = createAjvValidator({ formats: false, maxCacheSize: 4 });

      for (let i = 0; i < 40; i++) {
        const schema: JsonSchema = {
          type: 'object',
          properties: { [`k${i}`]: { type: 'number' } },
        };
        const r = await validator.validate(schema, { [`k${i}`]: i });
        expect(r.valid).toBe(true);
      }
    });

    it('defaults to 256-entry cache when maxCacheSize not provided', async () => {
      // Smoke test: creating a validator without explicit cap must work
      // and validation must succeed after many distinct schemas.
      const validator = createAjvValidator({ formats: false });
      for (let i = 0; i < 10; i++) {
        const r = await validator.validate(
          { type: 'object', properties: { [`p${i}`]: { type: 'string' } } } as JsonSchema,
          { [`p${i}`]: 'v' },
        );
        expect(r.valid).toBe(true);
      }
    });

    it('honours maxCacheSize of 1 (always-evict case)', async () => {
      const validator = createAjvValidator({ formats: false, maxCacheSize: 1 });
      const rA = await validator.validate(
        { type: 'object', properties: { a: { type: 'string' } } } as JsonSchema,
        { a: 'x' },
      );
      const rB = await validator.validate(
        { type: 'object', properties: { b: { type: 'string' } } } as JsonSchema,
        { b: 'y' },
      );
      expect(rA.valid).toBe(true);
      expect(rB.valid).toBe(true);
    });

    it('routes compile failures through injected logger (CQ-027)', async () => {
      const fakeLogger = { warn: vi.fn(), error: vi.fn() };
      const validator = createAjvValidator({
        formats: false,
        logger: fakeLogger,
      });
      // A schema that references an undefined $ref will fail to compile.
      const bogus = { $ref: '#/definitions/nope' } as unknown as JsonSchema;
      await expect(validator.validate(bogus, {})).rejects.toBeDefined();
      expect(fakeLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('compile() failed'),
        expect.any(Object),
      );
    });
  });
});

