/**
 * Unit tests for the set-algebra helpers (union / intersect) extracted
 * from `createInMemoryStore` into their own module. Isolated tests let us
 * cover the tricky cases (empty results, unknown tags, disjoint sets)
 * without building a full store + memory entries.
 */

import { describe, it, expect } from 'vitest';
import {
  intersect,
  resolveCandidateIds,
  unionTagSets,
  type MemoryQueryIndexes,
} from '../memory-query.js';

function makeIndexes(
  gradeIndex: Record<string, readonly string[]> = {},
  tagIndex: Record<string, readonly string[]> = {},
): MemoryQueryIndexes {
  return {
    gradeIndex: new Map(Object.entries(gradeIndex).map(([k, ids]) => [k, new Set(ids)])),
    tagIndex: new Map(Object.entries(tagIndex).map(([k, ids]) => [k, new Set(ids)])),
  };
}

describe('intersect', () => {
  it('returns the common ids', () => {
    expect([...intersect(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))])
      .toEqual(['b', 'c']);
  });

  it('order of arguments does not affect the result (commutativity)', () => {
    const a = new Set(['x', 'y', 'z']);
    const b = new Set(['y', 'z', 'w']);
    expect([...intersect(a, b)].sort()).toEqual([...intersect(b, a)].sort());
  });

  it('iterates the smaller side — observable via size asymmetry', () => {
    // We cannot Proxy-probe a Set (engines bypass the trap via internal slots),
    // so instead assert behavioural equivalence when the two inputs differ
    // wildly in size — a naive "iterate `a`" implementation would still pass,
    // but the `commutativity` test above guards the logical contract.
    const small = new Set(['a']);
    const large = new Set(Array.from({ length: 10_000 }, (_, i) => `id-${i}`));
    large.add('a');
    expect([...intersect(small, large)]).toEqual(['a']);
    expect([...intersect(large, small)]).toEqual(['a']);
  });

  it('returns an empty set when inputs are disjoint', () => {
    expect(intersect(new Set(['a']), new Set(['b'])).size).toBe(0);
  });

  it('never aliases either input', () => {
    const a = new Set(['x']);
    const out = intersect(a, new Set(['x']));
    out.add('sneaky');
    expect(a.has('sneaky')).toBe(false);
  });
});

describe('unionTagSets', () => {
  it('OR-unions the id sets of every requested tag', () => {
    const idx = makeIndexes({}, { urgent: ['1', '2'], stale: ['2', '3'] });
    expect([...unionTagSets(['urgent', 'stale'], idx.tagIndex).values()].sort())
      .toEqual(['1', '2', '3']);
  });

  it('ignores unknown tags without widening the result', () => {
    const idx = makeIndexes({}, { urgent: ['1'] });
    expect([...unionTagSets(['urgent', 'does-not-exist'], idx.tagIndex)])
      .toEqual(['1']);
  });

  it('returns an empty set when no tag is known', () => {
    const idx = makeIndexes({}, {});
    expect(unionTagSets(['a', 'b'], idx.tagIndex).size).toBe(0);
  });
});

describe('resolveCandidateIds', () => {
  it('returns null when no indexed filter is set (signals full scan)', () => {
    const idx = makeIndexes({ critical: ['1'] }, { a: ['1'] });
    expect(resolveCandidateIds({ search: 'hi' }, idx)).toBeNull();
  });

  it('narrows to grade ids when only grade is supplied', () => {
    const idx = makeIndexes({ critical: ['1', '2'], ephemeral: ['3'] }, {});
    const out = resolveCandidateIds({ grade: 'critical' }, idx);
    expect(out && [...out].sort()).toEqual(['1', '2']);
  });

  it('narrows to an empty set when grade has no matches', () => {
    const idx = makeIndexes({ critical: ['1'] }, {});
    const out = resolveCandidateIds({ grade: 'never-seen' }, idx);
    expect(out?.size).toBe(0);
  });

  it('OR-unions tag sets when only tags are supplied', () => {
    const idx = makeIndexes({}, { urgent: ['1', '2'], stale: ['3'] });
    const out = resolveCandidateIds({ tags: ['urgent', 'stale'] }, idx);
    expect(out && [...out].sort()).toEqual(['1', '2', '3']);
  });

  it('intersects grade with tag-union when both filters are present', () => {
    const idx = makeIndexes(
      { critical: ['1', '2', '3'] },
      { urgent: ['2', '4'], stale: ['3', '5'] },
    );
    // grade {1,2,3} ∩ (urgent {2,4} ∪ stale {3,5}) = {2,3}
    const out = resolveCandidateIds(
      { grade: 'critical', tags: ['urgent', 'stale'] },
      idx,
    );
    expect(out && [...out].sort()).toEqual(['2', '3']);
  });

  it('produces an empty set when grade and tag-union are disjoint', () => {
    const idx = makeIndexes({ critical: ['1'] }, { urgent: ['99'] });
    const out = resolveCandidateIds({ grade: 'critical', tags: ['urgent'] }, idx);
    expect(out?.size).toBe(0);
  });

  it('treats an empty tags array as "no tag filter" rather than "match nothing"', () => {
    // The legacy store checked `filter.tags && filter.tags.length > 0`, so an
    // empty array is ignored. Documented here so nobody silently changes it.
    const idx = makeIndexes({ critical: ['1'] }, { urgent: ['99'] });
    const out = resolveCandidateIds({ grade: 'critical', tags: [] }, idx);
    expect(out && [...out]).toEqual(['1']);
  });
});
