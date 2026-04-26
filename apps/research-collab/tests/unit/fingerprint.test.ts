import { describe, expect, it } from 'vitest';

import { fingerprint } from '../../src/observability/fingerprint.js';

describe('fingerprint', () => {
  it('returns a 16-char hex digest', () => {
    const out = fingerprint('hello world');
    expect(out).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same input', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
  });

  it('produces different digests for different inputs', () => {
    expect(fingerprint('abc')).not.toBe(fingerprint('abcd'));
  });
});
