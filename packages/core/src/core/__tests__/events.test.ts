import { describe, it, expect } from 'vitest';
import { assertNever } from '../events.js';
import { HarnessError, HarnessErrorCode} from '../errors.js';

describe('assertNever', () => {
  it('throws HarnessError with a static (non-interpolated) message', () => {
    const value = 'unexpected_value' as never;
    expect(() => assertNever(value)).toThrow(HarnessError);
    // The message MUST NOT carry the value itself — if the discriminant ever
    // contains user-derived content, interpolating it would leak PII into
    // logs/traces. Only a static diagnostic should reach the error message;
    // the caller's stack identifies the bug location.
    expect(() => assertNever(value)).toThrow('Unexpected discriminant in exhaustive switch');
  });

  it('does not leak the runtime value into the error message', () => {
    const secret = 'sensitive-user-token-abc123' as never;
    try {
      assertNever(secret);
      expect.unreachable('assertNever should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).message).not.toContain('sensitive');
      expect((err as HarnessError).message).not.toContain('abc123');
    }
  });

  it('throws with UNEXPECTED_VALUE error code', () => {
    const value = 42 as never;
    try {
      assertNever(value);
      expect.unreachable('assertNever should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_UNEXPECTED_VALUE);
    }
  });

  it('includes a suggestion indicating a bug', () => {
    const value = null as never;
    try {
      assertNever(value);
      expect.unreachable('assertNever should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).suggestion).toContain('bug in harness-one');
    }
  });

  it('has return type never (compile-time check)', () => {
    // This test verifies the return type is `never` at compile time.
    // If assertNever's return type were not `never`, the following
    // would produce a type error in a discriminated union switch/case.
    type TestUnion = { type: 'a' } | { type: 'b' };
    function handleUnion(val: TestUnion): string {
      switch (val.type) {
        case 'a': return 'A';
        case 'b': return 'B';
        default: return assertNever(val.type);
      }
    }
    expect(handleUnion({ type: 'a' })).toBe('A');
    expect(handleUnion({ type: 'b' })).toBe('B');
  });
});
