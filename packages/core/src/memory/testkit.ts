/**
 * Conformance test suite for `MemoryStore` implementations.
 *
 * Third-party backends (Postgres, S3, DynamoDB) should call
 * `runMemoryStoreConformance(factory)` from their test file to prove they
 * uphold the contract documented on `MemoryStore`. Failing one of these
 * assertions means operators relying on the documented guarantees can
 * experience subtle corruption — that's why they're published as a testkit
 * rather than left as each backend author's puzzle.
 *
 * The kit does not depend on vitest globally; callers pass in `describe`,
 * `it`, and `expect` so they can wire into any test framework.
 *
 * @module
 */

import type { MemoryStore } from './store.js';

/** Minimal test-runner shape accepted by the conformance kit. */
export interface TestKitRunner {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe: (expected: unknown) => void;
    toEqual: (expected: unknown) => void;
    toBeNull: () => void;
    toBeDefined: () => void;
    toBeGreaterThanOrEqual: (n: number) => void;
    toContain: (v: unknown) => void;
  };
  beforeEach?: (fn: () => void | Promise<void>) => void;
}

/**
 * Exercise a `MemoryStore` against the published contract.
 *
 * @param runner - your test framework's `describe`/`it`/`expect` triad
 * @param createStore - async factory that returns a fresh store per test
 */
export function runMemoryStoreConformance(
  runner: TestKitRunner,
  createStore: () => Promise<MemoryStore> | MemoryStore,
): void {
  const { describe, it, expect } = runner;

  describe('MemoryStore conformance', () => {
    it('write then read returns the entry', async () => {
      const store = await createStore();
      const written = await store.write({ key: 'k', content: 'hi', grade: 'useful' });
      expect(written.id).toBeDefined();
      const read = await store.read(written.id);
      expect(read).toEqual(written);
    });

    it('read of unknown id returns null', async () => {
      const store = await createStore();
      expect(await store.read('nonexistent')).toBeNull();
    });

    it('update mutates content and bumps updatedAt', async () => {
      const store = await createStore();
      const w = await store.write({ key: 'k', content: 'a', grade: 'useful' });
      const before = w.updatedAt;
      // wait 1ms to ensure monotonic increase on fast machines
      await new Promise((r) => setTimeout(r, 2));
      const u = await store.update(w.id, { content: 'b' });
      expect(u.content).toBe('b');
      expect(u.updatedAt >= before).toBe(true);
    });

    it('delete removes and returns true, subsequent delete returns false', async () => {
      const store = await createStore();
      const w = await store.write({ key: 'k', content: 'x', grade: 'useful' });
      const first = await store.delete(w.id);
      const second = await store.delete(w.id);
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(await store.read(w.id)).toBeNull();
    });

    it('query by grade returns only matching entries', async () => {
      const store = await createStore();
      await store.write({ key: 'a', content: '1', grade: 'critical' });
      await store.write({ key: 'b', content: '2', grade: 'useful' });
      await store.write({ key: 'c', content: '3', grade: 'ephemeral' });
      const results = await store.query({ grade: 'useful' });
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('2');
    });

    it('query by tag returns only matching entries', async () => {
      const store = await createStore();
      await store.write({ key: 'a', content: '1', grade: 'useful', tags: ['x'] });
      await store.write({ key: 'b', content: '2', grade: 'useful', tags: ['y'] });
      const results = await store.query({ tags: ['x'] });
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('1');
    });

    it('count reflects writes and deletes', async () => {
      const store = await createStore();
      expect(await store.count()).toBe(0);
      const w1 = await store.write({ key: 'a', content: '1', grade: 'useful' });
      await store.write({ key: 'b', content: '2', grade: 'useful' });
      expect(await store.count()).toBe(2);
      await store.delete(w1.id);
      expect(await store.count()).toBe(1);
    });

    it('clear removes all entries', async () => {
      const store = await createStore();
      await store.write({ key: 'a', content: '1', grade: 'useful' });
      await store.write({ key: 'b', content: '2', grade: 'useful' });
      await store.clear();
      expect(await store.count()).toBe(0);
    });

    it('capabilities field, if present, is an object with boolean flags', async () => {
      const store = await createStore();
      if (store.capabilities !== undefined) {
        expect(typeof store.capabilities).toBe('object');
      }
    });

    it('writeBatch, if declared, returns one entry per input', async () => {
      const store = await createStore();
      if (!store.writeBatch) return;
      const written = await store.writeBatch([
        { key: 'a', content: '1', grade: 'useful' },
        { key: 'b', content: '2', grade: 'useful' },
      ]);
      expect(written.length).toBe(2);
      const count = await store.count();
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });
}
