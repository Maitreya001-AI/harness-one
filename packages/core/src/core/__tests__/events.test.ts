import { describe, it, expect } from 'vitest';
import { assertNever } from '../events.js';
import { HarnessError, HarnessErrorCode} from '../errors.js';

describe('assertNever', () => {
  it('throws HarnessError with the unexpected value in the message', () => {
    const value = 'unexpected_value' as never;
    expect(() => assertNever(value)).toThrow(HarnessError);
    expect(() => assertNever(value)).toThrow('Unexpected value: unexpected_value');
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
      expect((err as HarnessError).suggestion).toBe('This is a bug in harness-one');
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
