import { describe, it, expect, expectTypeOf } from 'vitest';
import { omitUndefined } from '../omit-undefined.js';

describe('omitUndefined — runtime behaviour', () => {
  it('strips undefined-valued keys from a flat object', () => {
    expect(omitUndefined({ a: 1, b: undefined, c: 3 })).toEqual({ a: 1, c: 3 });
  });

  it('preserves null, 0, "", false', () => {
    expect(omitUndefined({ a: null, b: 0, c: '', d: false })).toEqual({
      a: null,
      b: 0,
      c: '',
      d: false,
    });
  });

  it('returns an empty object when all values are undefined', () => {
    expect(omitUndefined({ a: undefined, b: undefined })).toEqual({});
  });

  it('returns an empty object when input is empty', () => {
    expect(omitUndefined({})).toEqual({});
  });

  it('does not mutate the input', () => {
    const input = { a: 1, b: undefined };
    const _output = omitUndefined(input);
    expect(input).toEqual({ a: 1, b: undefined });
  });

  it('returns a fresh object reference', () => {
    const input = { a: 1 };
    expect(omitUndefined(input)).not.toBe(input);
  });

  it('preserves symbol-keyed properties', () => {
    const sym = Symbol('s');
    const out = omitUndefined({ a: 1, [sym]: 'value' }) as Record<string | symbol, unknown>;
    expect(out[sym]).toBe('value');
  });

  it('strips undefined symbol-keyed properties', () => {
    const sym = Symbol('s');
    const out = omitUndefined({ a: 1, [sym]: undefined }) as Record<string | symbol, unknown>;
    expect(Object.getOwnPropertySymbols(out)).toEqual([]);
  });

  it('does NOT copy inherited properties (matches spread semantics)', () => {
    const parent = { inherited: 'nope' };
    const child = Object.create(parent) as { own: number };
    child.own = 1;
    const out = omitUndefined(child);
    expect(out).toEqual({ own: 1 });
    expect('inherited' in out).toBe(false);
  });

  it('handles deeply-nested undefined-bearing objects (does not recurse)', () => {
    // Top-level undefined is stripped; nested undefined is preserved
    // (deep-strip would change semantics — caller should map explicitly).
    const out = omitUndefined({ a: { b: undefined }, c: undefined });
    expect(out).toEqual({ a: { b: undefined } });
  });
});

describe('omitUndefined — type narrowing', () => {
  it('removes undefined from optional value union', () => {
    type Cfg = { name: string; timeout?: number; signal?: AbortSignal };
    const cfg: Cfg = { name: 'agent' };
    const out = omitUndefined(cfg);
    // TypeScript-side: out.timeout has type `number` (not `number | undefined`)
    // when present. The runtime check is implicit via the object equality.
    expectTypeOf(out.timeout).toEqualTypeOf<number>();
    expectTypeOf(out.signal).toEqualTypeOf<AbortSignal>();
  });

  it('preserves keys that the input never declared optional', () => {
    type Strict = { id: string; count: number };
    const out = omitUndefined<Strict>({ id: 'x', count: 0 });
    expectTypeOf(out.id).toEqualTypeOf<string>();
    expectTypeOf(out.count).toEqualTypeOf<number>();
  });
});
