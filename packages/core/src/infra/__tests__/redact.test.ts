import { describe, it, expect } from 'vitest';
import {
  createRedactor,
  redactValue,
  sanitizeAttributes,
  REDACTED_VALUE,
  DEFAULT_SECRET_PATTERN,
  POLLUTING_KEYS,
} from '../redact.js';

describe('redact', () => {
  describe('DEFAULT_SECRET_PATTERN', () => {
    it.each([
      'apiKey',
      'api_key',
      'api-key',
      'API_KEY',
      'authorization',
      'Authorization',
      'auth_token',
      'secret',
      'my_secret',
      'token',
      'access_token',
      'refresh_token',
      'password',
      'user.password',
      'session_id',
      'private_key',
      'bearer',
      'cookie',
      'credential',
      'x-api-key',
    ])('matches %s', (key) => {
      DEFAULT_SECRET_PATTERN.lastIndex = 0;
      expect(DEFAULT_SECRET_PATTERN.test(key)).toBe(true);
    });

    it.each(['name', 'id', 'count', 'message', 'url', 'model'])('does not match %s', (key) => {
      DEFAULT_SECRET_PATTERN.lastIndex = 0;
      expect(DEFAULT_SECRET_PATTERN.test(key)).toBe(false);
    });
  });

  describe('createRedactor', () => {
    it('redacts default secret keys', () => {
      const r = createRedactor();
      expect(r.shouldRedactKey('apiKey')).toBe(true);
      expect(r.shouldRedactKey('authorization')).toBe(true);
      expect(r.shouldRedactKey('name')).toBe(false);
    });

    it('allows disabling default pattern', () => {
      const r = createRedactor({ useDefaultPattern: false });
      expect(r.shouldRedactKey('apiKey')).toBe(false);
    });

    it('applies extra exact keys (case-insensitive)', () => {
      const r = createRedactor({ extraKeys: ['X-Custom-Header'] });
      expect(r.shouldRedactKey('x-custom-header')).toBe(true);
      expect(r.shouldRedactKey('X-CUSTOM-HEADER')).toBe(true);
      expect(r.shouldRedactKey('other')).toBe(false);
    });

    it('applies extra patterns', () => {
      const r = createRedactor({ extraPatterns: [/internal_/i] });
      expect(r.shouldRedactKey('internal_token')).toBe(true);
      expect(r.shouldRedactKey('name')).toBe(false);
    });

    it('extra patterns defensively reset lastIndex across calls', () => {
      const p = /foo/g;
      const r = createRedactor({ extraPatterns: [p] });
      expect(r.shouldRedactKey('foo')).toBe(true);
      expect(r.shouldRedactKey('foo')).toBe(true); // would fail if lastIndex not reset
    });

    it('blocks polluting keys by default', () => {
      const r = createRedactor();
      for (const k of POLLUTING_KEYS) {
        expect(r.isPollutingKey(k)).toBe(true);
      }
      expect(r.isPollutingKey('foo')).toBe(false);
    });

    it('respects blockPollutingKeys=false', () => {
      const r = createRedactor({ blockPollutingKeys: false });
      expect(r.isPollutingKey('__proto__')).toBe(false);
    });

    it('handles non-string keys safely', () => {
      const r = createRedactor();
      // @ts-expect-error — explicit non-string
      expect(r.shouldRedactKey(123)).toBe(false);
    });
  });

  describe('redactValue', () => {
    const r = createRedactor();

    it('returns primitives unchanged', () => {
      expect(redactValue(null, r)).toBe(null);
      expect(redactValue(1, r)).toBe(1);
      expect(redactValue('hello', r)).toBe('hello');
      expect(redactValue(true, r)).toBe(true);
    });

    it('redacts sensitive keys in objects', () => {
      const out = redactValue({ apiKey: 'sk-123', name: 'x' }, r);
      expect(out).toEqual({ apiKey: REDACTED_VALUE, name: 'x' });
    });

    it('drops polluting keys', () => {
      const input = Object.assign(Object.create(null), { safe: 1, __proto__: { foo: 1 } });
      const out = redactValue({ ...input }, r);
      expect(out).toEqual({ safe: 1 });
    });

    it('recurses into nested objects', () => {
      const out = redactValue({ user: { password: 'p', name: 'n' } }, r);
      expect(out).toEqual({ user: { password: REDACTED_VALUE, name: 'n' } });
    });

    it('recurses into arrays', () => {
      const out = redactValue([{ token: 'a' }, { token: 'b' }], r);
      expect(out).toEqual([{ token: REDACTED_VALUE }, { token: REDACTED_VALUE }]);
    });

    it('preserves Dates as ISO strings', () => {
      const d = new Date('2024-01-01T00:00:00Z');
      expect(redactValue({ when: d }, r)).toEqual({ when: d.toISOString() });
    });

    it('flattens Error objects', () => {
      const err = new Error('boom');
      const out = redactValue({ err }, r) as { err: { name: string; message: string } };
      expect(out.err.name).toBe('Error');
      expect(out.err.message).toBe('boom');
    });

    it('handles circular references', () => {
      const a: Record<string, unknown> = { name: 'a' };
      a.self = a;
      const out = redactValue(a, r) as Record<string, unknown>;
      expect(out.name).toBe('a');
      expect(out.self).toBe('[Circular]');
    });
  });

  describe('sanitizeAttributes', () => {
    const r = createRedactor();

    it('drops polluting top-level keys', () => {
      const out = sanitizeAttributes(
        { __proto__: { pwned: true }, safe: 1, apiKey: 'x' } as Record<string, unknown>,
        r,
      );
      expect(out).not.toHaveProperty('__proto__');
      expect(out.safe).toBe(1);
      expect(out.apiKey).toBe(REDACTED_VALUE);
    });

    it('redacts sensitive top-level keys and recurses', () => {
      const out = sanitizeAttributes(
        { nested: { token: 't', name: 'n' }, safe: 1 },
        r,
      );
      expect(out).toEqual({ nested: { token: REDACTED_VALUE, name: 'n' }, safe: 1 });
    });

    it('returns a fresh object (input not mutated)', () => {
      const input = { apiKey: 'x' };
      sanitizeAttributes(input, r);
      expect(input.apiKey).toBe('x');
    });
  });
});
