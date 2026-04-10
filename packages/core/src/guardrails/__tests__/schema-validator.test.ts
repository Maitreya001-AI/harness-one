import { describe, it, expect } from 'vitest';
import { createSchemaValidator } from '../schema-validator.js';

describe('createSchemaValidator', () => {
  // ---- Valid JSON against schema ----

  describe('validates against JSON schema', () => {
    it('allows valid object matching schema', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      });

      expect(guard({ content: '{"name":"Alice"}' }).action).toBe('allow');
    });

    it('allows valid string', () => {
      const { guard } = createSchemaValidator({ type: 'string' });
      expect(guard({ content: '"hello"' }).action).toBe('allow');
    });

    it('allows valid number', () => {
      const { guard } = createSchemaValidator({ type: 'number' });
      expect(guard({ content: '42' }).action).toBe('allow');
    });

    it('allows valid boolean', () => {
      const { guard } = createSchemaValidator({ type: 'boolean' });
      expect(guard({ content: 'true' }).action).toBe('allow');
    });

    it('allows valid array', () => {
      const { guard } = createSchemaValidator({
        type: 'array',
        items: { type: 'number' },
      });
      expect(guard({ content: '[1, 2, 3]' }).action).toBe('allow');
    });

    it('allows null when schema expects null', () => {
      const { guard } = createSchemaValidator({ type: 'null' });
      expect(guard({ content: 'null' }).action).toBe('allow');
    });

    it('allows valid nested object', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              age: { type: 'number' },
            },
            required: ['name'],
          },
        },
        required: ['user'],
      });

      const valid = guard({ content: JSON.stringify({ user: { name: 'Bob', age: 30 } }) });
      expect(valid.action).toBe('allow');
    });
  });

  // ---- Reports validation errors ----

  describe('reports validation errors', () => {
    it('blocks invalid JSON (not parseable)', () => {
      const { guard } = createSchemaValidator({ type: 'object' });
      const result = guard({ content: 'not json at all' });

      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('Invalid JSON');
      }
    });

    it('blocks malformed JSON', () => {
      const { guard } = createSchemaValidator({ type: 'object' });
      const result = guard({ content: '{invalid json!!!' });

      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('Invalid JSON');
      }
    });

    it('blocks wrong type', () => {
      const { guard } = createSchemaValidator({ type: 'string' });
      const result = guard({ content: '42' });

      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('string');
      }
    });

    it('blocks missing required fields', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'age'],
      });

      const result = guard({ content: '{}' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('required');
      }
    });

    it('blocks wrong type in nested properties', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      });

      const result = guard({ content: '{"name": 42}' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('string');
      }
    });

    it('blocks array items that violate items schema', () => {
      const { guard } = createSchemaValidator({
        type: 'array',
        items: { type: 'string' },
      });

      const result = guard({ content: '["a", 42, "c"]' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('string');
      }
    });

    it('blocks missing required field in nested object', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              address: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
            required: ['name', 'address'],
          },
        },
        required: ['user'],
      });

      const result = guard({
        content: JSON.stringify({ user: { name: 'Alice', address: {} } }),
      });
      expect(result.action).toBe('block');
    });

    it('blocks when enum value does not match', () => {
      const { guard } = createSchemaValidator({
        type: 'string',
        enum: ['red', 'green', 'blue'],
      });

      expect(guard({ content: '"red"' }).action).toBe('allow');
      expect(guard({ content: '"yellow"' }).action).toBe('block');
    });
  });

  // ---- Redaction behavior ----

  describe('error redaction', () => {
    it('redacts field names in errors by default (redactErrors: true)', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
        required: ['user'],
      });

      const result = guard({
        content: JSON.stringify({ user: {} }),
      });

      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('[REDACTED]');
      }
    });

    it('shows raw field names when redactErrors is false', () => {
      const { guard } = createSchemaValidator(
        {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        { redactErrors: false },
      );

      const result = guard({ content: '{}' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('name');
        expect(result.reason).not.toContain('[REDACTED]');
      }
    });
  });

  // ---- String constraints ----

  describe('string constraints', () => {
    it('validates minLength', () => {
      const { guard } = createSchemaValidator({
        type: 'string',
        minLength: 3,
      });

      expect(guard({ content: '"ab"' }).action).toBe('block');
      expect(guard({ content: '"abc"' }).action).toBe('allow');
    });

    it('validates maxLength', () => {
      const { guard } = createSchemaValidator({
        type: 'string',
        maxLength: 5,
      });

      expect(guard({ content: '"hello"' }).action).toBe('allow');
      expect(guard({ content: '"toolong"' }).action).toBe('block');
    });

    it('validates pattern', () => {
      const { guard } = createSchemaValidator({
        type: 'string',
        pattern: '^[a-z]+$',
      });

      expect(guard({ content: '"abc"' }).action).toBe('allow');
      expect(guard({ content: '"ABC"' }).action).toBe('block');
    });
  });

  // ---- Number constraints ----

  describe('number constraints', () => {
    it('validates minimum', () => {
      const { guard } = createSchemaValidator({
        type: 'number',
        minimum: 10,
      });

      expect(guard({ content: '5' }).action).toBe('block');
      expect(guard({ content: '10' }).action).toBe('allow');
      expect(guard({ content: '15' }).action).toBe('allow');
    });

    it('validates maximum', () => {
      const { guard } = createSchemaValidator({
        type: 'number',
        maximum: 100,
      });

      expect(guard({ content: '100' }).action).toBe('allow');
      expect(guard({ content: '101' }).action).toBe('block');
    });
  });

  // ---- Edge cases ----

  describe('edge cases', () => {
    it('handles empty JSON object', () => {
      const { guard } = createSchemaValidator({ type: 'object' });
      expect(guard({ content: '{}' }).action).toBe('allow');
    });

    it('handles empty JSON array', () => {
      const { guard } = createSchemaValidator({ type: 'array' });
      expect(guard({ content: '[]' }).action).toBe('allow');
    });

    it('validates array with object items', () => {
      const { guard } = createSchemaValidator({
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'number' } },
          required: ['id'],
        },
      });

      expect(guard({ content: '[{"id": 1}, {"id": 2}]' }).action).toBe('allow');

      const result = guard({ content: '[{"id": 1}, {"name": "no id"}]' });
      expect(result.action).toBe('block');
    });

    it('blocks when content is empty string', () => {
      const { guard } = createSchemaValidator({ type: 'object' });
      const result = guard({ content: '' });
      expect(result.action).toBe('block');
    });
  });

  // ---- Combinator keywords (oneOf, anyOf, allOf, additionalProperties) ----
  // The internal JSON Schema validator does NOT support these keywords.
  // These tests document the current pass-through behavior: the keywords are
  // accepted in the schema type but silently ignored during validation.

  describe('oneOf (unsupported — documents pass-through behavior)', () => {
    it('allows values even when they do not match any oneOf branch', () => {
      // oneOf is declared in JsonSchema but not enforced by the validator
      const { guard } = createSchemaValidator({
        type: 'object',
        oneOf: [
          { type: 'object', properties: { kind: { type: 'string', enum: ['a'] } }, required: ['kind'] },
          { type: 'object', properties: { kind: { type: 'string', enum: ['b'] } }, required: ['kind'] },
        ],
      } as Parameters<typeof createSchemaValidator>[0]);

      // Value matches neither branch, but validator ignores oneOf — so it allows
      const result = guard({ content: '{"kind":"c"}' });
      expect(result.action).toBe('allow');
    });

    it('allows values that match one oneOf branch (pass-through)', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        oneOf: [
          { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
        ],
      } as Parameters<typeof createSchemaValidator>[0]);

      expect(guard({ content: '{"x":1}' }).action).toBe('allow');
    });
  });

  describe('anyOf (unsupported — documents pass-through behavior)', () => {
    it('allows values even when they do not match any anyOf branch', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        anyOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
        ],
      } as Parameters<typeof createSchemaValidator>[0]);

      // No 'a' or 'b' — anyOf would fail, but validator ignores it
      const result = guard({ content: '{"c":true}' });
      expect(result.action).toBe('allow');
    });

    it('allows values matching one anyOf branch (pass-through)', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        anyOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        ],
      } as Parameters<typeof createSchemaValidator>[0]);

      expect(guard({ content: '{"a":"hello"}' }).action).toBe('allow');
    });
  });

  describe('allOf (unsupported — documents pass-through behavior)', () => {
    it('allows values even when they violate allOf constraints', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        allOf: [
          { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
          { type: 'object', properties: { y: { type: 'number' } }, required: ['y'] },
        ],
      } as Parameters<typeof createSchemaValidator>[0]);

      // Missing 'x' and 'y' — allOf would fail, but validator ignores it
      const result = guard({ content: '{}' });
      expect(result.action).toBe('allow');
    });

    it('allows values satisfying all allOf schemas (pass-through)', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        allOf: [
          { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
          { type: 'object', properties: { y: { type: 'string' } }, required: ['y'] },
        ],
      } as Parameters<typeof createSchemaValidator>[0]);

      expect(guard({ content: '{"x":1,"y":"a"}' }).action).toBe('allow');
    });
  });

  describe('additionalProperties (unsupported — documents pass-through behavior)', () => {
    it('allows additional properties even when additionalProperties is false', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      });

      // Has 'extra' property — additionalProperties: false would block, but validator ignores it
      const result = guard({ content: '{"name":"Alice","extra":123}' });
      expect(result.action).toBe('allow');
    });

    it('allows additional properties when additionalProperties is a schema (pass-through)', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: { type: 'number' } as unknown as boolean,
      });

      // 'extra' is a string, not number — would fail with additionalProperties schema, but ignored
      const result = guard({ content: '{"name":"Alice","extra":"not a number"}' });
      expect(result.action).toBe('allow');
    });

    it('still validates declared properties even when additionalProperties is set', () => {
      const { guard } = createSchemaValidator({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      });

      // Missing required 'name' — this IS validated
      const result = guard({ content: '{}' });
      expect(result.action).toBe('block');
    });
  });

  // ---- Name ----

  it('has name "schema-validator"', () => {
    const validator = createSchemaValidator({ type: 'string' });
    expect(validator.name).toBe('schema-validator');
  });
});
