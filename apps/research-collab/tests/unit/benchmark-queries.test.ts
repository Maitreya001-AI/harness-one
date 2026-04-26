import { describe, expect, it } from 'vitest';

import { BENCHMARK_QUERIES, findBenchmarkQuery } from '../../src/config/benchmark-queries.js';

describe('benchmark queries', () => {
  it('exposes a non-empty frozen corpus', () => {
    expect(BENCHMARK_QUERIES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(BENCHMARK_QUERIES)).toBe(true);
    for (const q of BENCHMARK_QUERIES) {
      expect(q.slug).toMatch(/^[a-z0-9-]+$/);
      expect(q.question.length).toBeGreaterThan(10);
      expect(q.tags.length).toBeGreaterThan(0);
    }
  });

  it('finds queries by slug', () => {
    const expected = BENCHMARK_QUERIES[0]!;
    const found = findBenchmarkQuery(expected.slug);
    expect(found).toEqual(expected);
  });

  it('returns undefined for unknown slugs', () => {
    expect(findBenchmarkQuery('does-not-exist')).toBeUndefined();
  });
});
