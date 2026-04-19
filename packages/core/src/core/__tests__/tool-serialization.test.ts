/**
 * Tests for `tool-serialization.ts` — the round-3 extraction from
 * iteration-runner.
 */
import { describe, it, expect } from 'vitest';
import {
  safeStringifyToolResult,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULT_KEYS_PER_CONTAINER,
  TRUNCATION_MARKER,
  WIDTH_TRUNCATION_MARKER,
} from '../tool-serialization.js';

describe('safeStringifyToolResult', () => {
  it('serialises primitive inputs verbatim', () => {
    expect(safeStringifyToolResult(42)).toBe('42');
    expect(safeStringifyToolResult('hi')).toBe('"hi"');
    expect(safeStringifyToolResult(null)).toBe('null');
    expect(safeStringifyToolResult(true)).toBe('true');
  });

  it('breaks cycles with [circular]', () => {
    type Node = { self?: Node };
    const o: Node = {};
    o.self = o;
    const result = safeStringifyToolResult(o);
    expect(result).toContain('[circular]');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('truncates past MAX_TOOL_RESULT_DEPTH', () => {
    // Build depth 20 nested object — depth cap is 10, so anything beyond
    // depth 10 is dropped (undefined replacer → skipped or null in arrays).
    type Deep = { next?: Deep; leaf?: string };
    let deep: Deep = { leaf: 'bottom' };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const out = safeStringifyToolResult(deep);
    // Undefined from replacer drops the key, so 'bottom' never appears once
    // depth exceeds the cap.
    expect(out).not.toContain('bottom');
  });

  it('truncates wide objects per MAX_TOOL_RESULT_KEYS_PER_CONTAINER', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < MAX_TOOL_RESULT_KEYS_PER_CONTAINER + 50; i++) {
      wide[`k${i}`] = i;
    }
    const out = safeStringifyToolResult(wide);
    expect(out).toContain(WIDTH_TRUNCATION_MARKER);
    // Keys past the cap must not appear.
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['__truncated__']).toBe(WIDTH_TRUNCATION_MARKER);
    expect(parsed['k0']).toBe(0);
    // Exactly `MAX_TOOL_RESULT_KEYS_PER_CONTAINER` keys kept + truncation sentinel.
    expect(Object.keys(parsed).length).toBe(MAX_TOOL_RESULT_KEYS_PER_CONTAINER + 1);
  });

  it('truncates wide arrays per width cap', () => {
    const arr = Array.from({ length: MAX_TOOL_RESULT_KEYS_PER_CONTAINER + 20 }, (_, i) => i);
    const out = safeStringifyToolResult(arr);
    expect(out).toContain(WIDTH_TRUNCATION_MARKER);
    const parsed = JSON.parse(out) as unknown[];
    expect(parsed.length).toBe(MAX_TOOL_RESULT_KEYS_PER_CONTAINER + 1);
    expect(parsed[parsed.length - 1]).toBe(WIDTH_TRUNCATION_MARKER);
  });

  it('falls back to truncation marker when serialized bytes exceed cap', () => {
    const big = 'a'.repeat(MAX_TOOL_RESULT_BYTES + 1000);
    const out = safeStringifyToolResult(big);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(out.length).toBe(MAX_TOOL_RESULT_BYTES);
  });

  it('returns a sentinel when value is not serialisable', () => {
    expect(safeStringifyToolResult(undefined)).toBe('[result not serializable]');
    expect(safeStringifyToolResult(() => 1)).toBe('[result not serializable]');
  });

  it('returns [Object could not be serialized] when JSON.stringify throws', () => {
    const bomb = {
      toJSON() {
        throw new Error('boom');
      },
    };
    expect(safeStringifyToolResult(bomb)).toBe('[Object could not be serialized]');
  });

  it('does not mistake siblings for depth descent', () => {
    // Regression: a wide-but-shallow object shouldn't be considered
    // "deep" just because of sibling count.
    const o: Record<string, { v: number }> = {};
    for (let i = 0; i < 50; i++) o[`k${i}`] = { v: i };
    const parsed = JSON.parse(safeStringifyToolResult(o)) as Record<string, { v: number }>;
    expect(parsed['k49']).toEqual({ v: 49 });
  });
});
