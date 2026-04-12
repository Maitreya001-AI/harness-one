/**
 * Schema validators for memory persistence boundaries. These guard every
 * JSON.parse(...) at the disk / network edge from turning into an `as T` cast.
 */
import { describe, it, expect } from 'vitest';
import {
  validateMemoryEntry,
  validateIndex,
  validateRelayState,
  parseJsonSafe,
} from '../_schemas.js';
import { HarnessError } from '../../core/errors.js';

describe('parseJsonSafe', () => {
  it('returns { ok: true, value } for valid JSON', () => {
    const res = parseJsonSafe('{"a":1}');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ a: 1 });
  });

  it('returns { ok: false, error } for invalid JSON', () => {
    const res = parseJsonSafe('{invalid');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(Error);
  });
});

describe('validateMemoryEntry', () => {
  const good = {
    id: 'abc',
    key: 'k',
    content: 'hello',
    grade: 'useful',
    createdAt: 1000,
    updatedAt: 2000,
  };

  it('accepts a minimal valid entry', () => {
    expect(validateMemoryEntry(good).id).toBe('abc');
  });

  it('accepts an entry with optional metadata and tags', () => {
    const entry = validateMemoryEntry({ ...good, metadata: { x: 1 }, tags: ['a', 'b'] });
    expect(entry.tags).toEqual(['a', 'b']);
    expect(entry.metadata).toEqual({ x: 1 });
  });

  it.each([
    ['non-object', 42, /expected object/],
    ['null', null, /expected object/],
    ['array', ['nope'], /expected object/],
    ['missing id', { ...good, id: undefined }, /expected non-empty string/],
    ['empty id', { ...good, id: '' }, /expected non-empty string/],
    ['non-string key', { ...good, key: 123 }, /expected string/],
    ['non-string content', { ...good, content: null }, /expected string/],
    ['invalid grade', { ...good, grade: 'super' }, /expected one of/],
    ['non-number createdAt', { ...good, createdAt: 'now' }, /expected finite number/],
    ['Infinity updatedAt', { ...good, updatedAt: Infinity }, /expected finite number/],
    ['non-object metadata', { ...good, metadata: 'meta' }, /expected object or undefined/],
    ['tags not array', { ...good, tags: 'single' }, /expected array or undefined/],
    ['tag item not string', { ...good, tags: [1, 2] }, /expected string/],
  ])('rejects %s', (_label, input, re) => {
    expect(() => validateMemoryEntry(input)).toThrow(re as RegExp);
  });

  it('wraps shape mismatch in HarnessError(STORE_CORRUPTION)', () => {
    try {
      validateMemoryEntry({ ...good, grade: 'invalid' });
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).code).toBe('STORE_CORRUPTION');
      expect((err as HarnessError).suggestion).toContain('backing store');
      return;
    }
    expect.fail('should have thrown');
  });
});

describe('validateIndex', () => {
  it('accepts empty keys', () => {
    expect(validateIndex({ keys: {} })).toEqual({ keys: {} });
  });

  it('accepts valid id mapping', () => {
    expect(validateIndex({ keys: { k1: 'id-1', k2: 'id-2' } }).keys.k1).toBe('id-1');
  });

  it.each([
    ['non-object', 'hello', /expected object/],
    ['missing keys', { other: {} }, /expected object/],
    ['non-string id', { keys: { k: 42 } }, /expected non-empty string id/],
    ['empty id', { keys: { k: '' } }, /expected non-empty string id/],
  ])('rejects %s', (_label, input, re) => {
    expect(() => validateIndex(input)).toThrow(re as RegExp);
  });
});

describe('validateRelayState', () => {
  const good = {
    progress: { step: 1 },
    artifacts: ['a.txt'],
    checkpoint: 'ckpt-1',
    timestamp: 1000,
  };

  it('accepts a valid state', () => {
    expect(validateRelayState(good).checkpoint).toBe('ckpt-1');
  });

  it('accepts valid state with _version', () => {
    expect(validateRelayState({ ...good, _version: 5 })._version).toBe(5);
  });

  it.each([
    ['non-object progress', { ...good, progress: null }, /expected object/],
    ['non-array artifacts', { ...good, artifacts: 'file' }, /expected array/],
    ['non-string artifact', { ...good, artifacts: [1] }, /expected string/],
    ['missing checkpoint', { ...good, checkpoint: undefined }, /expected string/],
    ['NaN timestamp', { ...good, timestamp: Number.NaN }, /expected finite number/],
    ['non-number _version', { ...good, _version: 'v5' }, /expected finite number or undefined/],
  ])('rejects %s', (_label, input, re) => {
    expect(() => validateRelayState(input)).toThrow(re as RegExp);
  });
});
