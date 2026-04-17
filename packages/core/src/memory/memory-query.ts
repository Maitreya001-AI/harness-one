/**
 * Set-algebra helpers for the in-memory {@link createInMemoryStore} query
 * path.
 *
 * Wave-16 m7 extraction. Lives in its own module so `store.ts` can focus on
 * CRUD + index maintenance + eviction, while this file owns the "combine
 * indexed filters into a candidate-id set" concern.
 *
 * Semantics (documented invariants — do not weaken silently):
 *
 *   - Tag filter has **OR** semantics: a candidate id qualifies if it bears
 *     **any** of the requested tags.
 *   - Grade filter is a single value.
 *   - When both filters are present, the tag **union** is **intersected**
 *     with the grade set — i.e. `(id ∈ grade) ∧ (id ∈ ⋃tag sets)`.
 *   - Returning `null` signals "no indexed filter applied — caller must
 *     fall back to a full table scan". This matches the legacy store
 *     behaviour so no test fixture needs to change.
 *
 * @module
 * @internal
 */

import type { MemoryFilter } from './types.js';

/**
 * Shape of the indexes the in-memory store maintains. Passing them in via
 * an interface keeps this module free of any dependency on the store's
 * closure state, which makes unit-testing trivial (pass any `Map<string,
 * Set<string>>` you like).
 */
export interface MemoryQueryIndexes {
  /** grade value -> set of ids with that grade. */
  readonly gradeIndex: ReadonlyMap<string, ReadonlySet<string>>;
  /** tag value -> set of ids that bear that tag. */
  readonly tagIndex: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Compute the candidate id set by combining indexed filter fields. Returns
 * `null` when the filter names no indexed field (grade / tags), telling the
 * caller to fall back to a full scan.
 *
 * The result is a fresh, owning `Set<string>`. The caller is free to mutate
 * it (e.g. to resolve ids into entries). No index internals are aliased out.
 */
export function resolveCandidateIds(
  filter: MemoryFilter,
  indexes: MemoryQueryIndexes,
): Set<string> | null {
  let candidateIds: Set<string> | null = null;

  if (filter.grade !== undefined) {
    const gradeSet = indexes.gradeIndex.get(filter.grade);
    candidateIds = gradeSet ? new Set(gradeSet) : new Set();
  }

  if (filter.tags && filter.tags.length > 0) {
    const tagUnion = unionTagSets(filter.tags, indexes.tagIndex);
    if (candidateIds !== null) {
      candidateIds = intersect(candidateIds, tagUnion);
    } else {
      candidateIds = tagUnion;
    }
  }

  return candidateIds;
}

/**
 * Union of all id-sets for the requested tag values. Missing tags contribute
 * an empty set (i.e. they do not widen the result). Exposed for focused unit
 * tests; not a hot path — the allocation is one Set per query.
 */
export function unionTagSets(
  tags: readonly string[],
  tagIndex: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const out = new Set<string>();
  for (const tag of tags) {
    const set = tagIndex.get(tag);
    if (set) {
      for (const id of set) out.add(id);
    }
  }
  return out;
}

/**
 * Intersect `a` with `b`. Iterates the smaller input for cache friendliness.
 * Mutation-free: always returns a fresh Set.
 */
export function intersect(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): Set<string> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<string>();
  for (const id of small) {
    if (large.has(id)) out.add(id);
  }
  return out;
}
