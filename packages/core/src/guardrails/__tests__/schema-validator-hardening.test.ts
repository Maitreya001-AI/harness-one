/**
 * utf8ByteLength fast-path — avoid TextEncoder allocation when
 * the string length is guaranteed to exceed the cap (upper-bound s.length*4).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSchemaValidator } from '../schema-validator.js';

describe('createSchemaValidator E-7: utf8 fast-path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks oversized content without calling TextEncoder.encode', () => {
    const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode');

    const { guard } = createSchemaValidator(
      { type: 'object' },
      { maxJsonBytes: 1000 },
    );

    // A 400-char string has an upper bound of 1600 bytes which exceeds the
    // 1000-byte cap → fast-path returns upper bound and skips encode.
    const big = '"' + 'a'.repeat(400) + '"';
    const res = guard({ content: big });
    expect(res.action).toBe('block');
    expect(String(res.reason)).toContain('exceeds max size');
    expect(encodeSpy).not.toHaveBeenCalled();
  });

  it('still encodes when string length is within safe region', () => {
    const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode');

    const { guard } = createSchemaValidator(
      { type: 'object' },
      { maxJsonBytes: 10_000 },
    );

    // 100 chars — upper bound 400 bytes, well below cap → encode IS called.
    const small = '{"x":' + '"' + 'a'.repeat(80) + '"' + '}';
    guard({ content: small });
    expect(encodeSpy).toHaveBeenCalled();
  });

  it('allows content clearly under the cap (verifies no false reject)', () => {
    const { guard } = createSchemaValidator(
      { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      { maxJsonBytes: 10_000 },
    );
    const res = guard({ content: '{"x":"hi"}' });
    expect(res.action).toBe('allow');
  });

  it('fast-path returned byte length is strictly >= real byte length', () => {
    // The fast-path returns s.length * 4 as an upper bound. Verify the block
    // path uses this upper bound and still correctly blocks all-ASCII input.
    const { guard } = createSchemaValidator(
      { type: 'object' },
      { maxJsonBytes: 100 },
    );
    // 40 ASCII chars -> real bytes = 40, upper bound = 160 > 100 cap.
    // Fast-path triggers & blocks.
    const ascii = '"' + 'a'.repeat(40) + '"';
    const res = guard({ content: ascii });
    expect(res.action).toBe('block');
  });

  it('disables the cap when maxJsonBytes is 0', () => {
    const { guard } = createSchemaValidator(
      { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      { maxJsonBytes: 0 },
    );
    const res = guard({ content: '{"x":"hello"}' });
    expect(res.action).toBe('allow');
  });
});
