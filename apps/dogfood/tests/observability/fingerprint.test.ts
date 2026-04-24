import { describe, expect, it } from 'vitest';

import { fingerprint } from '../../src/observability/fingerprint.js';

describe('fingerprint', () => {
  it('produces a stable 16-char hex string', () => {
    const fp = fingerprint('hello world');
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
    expect(fp).toBe(fingerprint('hello world'));
  });

  it('differs for different inputs', () => {
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});
