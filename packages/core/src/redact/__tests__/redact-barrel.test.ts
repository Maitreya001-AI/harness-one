/**
 * Contract tests for the `harness-one/redact` barrel. Ensures the
 * public symbols remain exported (both names and runtime behaviour)
 * after the hoist from `harness-one/observe`.
 */

import { describe, it, expect } from 'vitest';
import {
  createRedactor,
  redactValue,
  sanitizeAttributes,
  REDACTED_VALUE,
  DEFAULT_SECRET_PATTERN,
  POLLUTING_KEYS,
} from '../index.js';

describe('harness-one/redact public surface', () => {
  it('exposes the canonical constants', () => {
    expect(REDACTED_VALUE).toBe('[REDACTED]');
    expect(DEFAULT_SECRET_PATTERN).toBeInstanceOf(RegExp);
    expect(POLLUTING_KEYS.has('__proto__')).toBe(true);
    expect(POLLUTING_KEYS.has('constructor')).toBe(true);
    expect(POLLUTING_KEYS.has('prototype')).toBe(true);
  });

  it('createRedactor returns a working Redactor', () => {
    const r = createRedactor();
    expect(r.shouldRedactKey('api_key')).toBe(true);
    expect(r.shouldRedactKey('authorization')).toBe(true);
    expect(r.shouldRedactKey('foo')).toBe(false);
  });

  it('redactValue scrubs nested secrets', () => {
    const r = createRedactor();
    const out = redactValue({ user: 'alice', api_key: 'sk-abc123' }, r);
    expect((out as { api_key?: string }).api_key).toBe(REDACTED_VALUE);
    expect((out as { user?: string }).user).toBe('alice');
  });

  it('sanitizeAttributes drops polluting keys', () => {
    const r = createRedactor();
    const out = sanitizeAttributes(
      { a: 1, __proto__: { injected: 'yes' } } as unknown as Record<string, unknown>,
      r,
    );
    expect(out).toHaveProperty('a');
    expect(out).not.toHaveProperty('__proto__');
  });
});
