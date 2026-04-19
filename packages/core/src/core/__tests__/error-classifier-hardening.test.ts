/**
 * Error classifier hardening:
 *
 *   - 5–7 sequential `.includes()` calls replaced with pre-compiled
 *     regex unions. Preserves classification ORDER semantics exactly.
 *   - fallback path emits a debug-level log via the optional logger
 *     port so unknown classifications are no longer silent.
 */

import { describe, it, expect, vi } from 'vitest';
import { categorizeAdapterError } from '../error-classifier.js';
import { HarnessErrorCode } from '../errors.js';

describe('categorizeAdapterError — regex-union classification order', () => {
  it('rate-limit still beats auth when both keywords appear (order preserved)', () => {
    expect(
      categorizeAdapterError(new Error('Too many requests — unauthorized')),
    ).toBe(HarnessErrorCode.ADAPTER_RATE_LIMIT);
  });

  it('5xx upstream-unavailable still beats network when both appear', () => {
    expect(
      categorizeAdapterError(new Error('fetch failed with 503 service unavailable')),
    ).toBe(HarnessErrorCode.ADAPTER_UNAVAILABLE);
  });

  it('network category still wins over parse when both appear', () => {
    expect(categorizeAdapterError(new Error('timeout while parsing'))).toBe(
      HarnessErrorCode.ADAPTER_NETWORK,
    );
  });

  it('falls through to ADAPTER_ERROR when nothing matches', () => {
    expect(categorizeAdapterError(new Error('completely unknown failure mode'))).toBe(
      HarnessErrorCode.ADAPTER_ERROR,
    );
  });

  it('handles non-Error values without throwing', () => {
    expect(categorizeAdapterError(null)).toBe(HarnessErrorCode.ADAPTER_ERROR);
    expect(categorizeAdapterError(undefined)).toBe(HarnessErrorCode.ADAPTER_ERROR);
    expect(categorizeAdapterError(42)).toBe(HarnessErrorCode.ADAPTER_ERROR);
    expect(categorizeAdapterError('plain string')).toBe(HarnessErrorCode.ADAPTER_ERROR);
  });
});

describe('categorizeAdapterError — fallback path emits debug log', () => {
  it('calls logger.debug with sliced error_message on unknown classification', () => {
    const debug = vi.fn();
    const result = categorizeAdapterError(new Error('xyzzy unknown'), { debug });
    expect(result).toBe(HarnessErrorCode.ADAPTER_ERROR);
    expect(debug).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(
      'adapter error not classified',
      expect.objectContaining({ error_message: expect.stringContaining('xyzzy') }),
    );
  });

  it('does not invoke logger.debug when classification succeeds', () => {
    const debug = vi.fn();
    categorizeAdapterError(new Error('HTTP 429 too many'), { debug });
    expect(debug).not.toHaveBeenCalled();
  });

  it('clamps logged error_message to 200 chars', () => {
    const debug = vi.fn();
    const longMsg = 'mystery'.padEnd(1000, 'x');
    categorizeAdapterError(new Error(longMsg), { debug });
    const payload = debug.mock.calls[0][1] as { error_message: string };
    expect(payload.error_message.length).toBeLessThanOrEqual(200);
  });

  it('no-ops cleanly when logger is omitted (legacy call-site)', () => {
    expect(() =>
      categorizeAdapterError(new Error('some unclassifiable thing')),
    ).not.toThrow();
  });

  it('no-ops cleanly when logger.debug is omitted', () => {
    expect(() =>
      categorizeAdapterError(new Error('some unclassifiable thing'), {}),
    ).not.toThrow();
  });
});
