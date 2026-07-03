/**
 * Injectable-clock seam for the in-memory store (B8). Proves that entry
 * timestamps, the `mem_<time>_<rand>` id prefix, and TTL expiry all read the
 * injected clock — so TTL behaviour is testable by advancing virtual time,
 * with no real waiting and no `vi.useFakeTimers()`.
 */

import { describe, it, expect } from 'vitest';
import { createInMemoryStore } from '../store.js';
import type { Clock } from '../../infra/clock.js';

function fakeClock(start = 1_000): { clock: Clock; advance: (ms: number) => void } {
  let t = start;
  return { clock: { now: () => t }, advance: (ms: number) => { t += ms; } };
}

describe('createInMemoryStore — injectable clock', () => {
  it('stamps createdAt/updatedAt and the id prefix from the injected clock', async () => {
    const { clock } = fakeClock(5_000);
    const store = createInMemoryStore({ clock });
    const entry = await store.write({ key: 'k', content: 'c', grade: 'useful' });
    expect(entry.createdAt).toBe(5_000);
    expect(entry.updatedAt).toBe(5_000);
    expect(entry.id.startsWith('mem_5000_')).toBe(true);
  });

  it('setWithTtl expires exactly when virtual time passes the TTL deadline', async () => {
    const { clock, advance } = fakeClock(1_000);
    const store = createInMemoryStore({ clock });
    await store.setWithTtl!('session', 'value', 1_000); // deadline = 1000 + 1000 = 2000

    const [entry] = await store.query({});
    expect(entry).toBeDefined();

    // Just before the deadline: still present.
    advance(999); // now = 1999 < 2000
    expect(await store.read(entry.id)).not.toBeNull();

    // At/after the deadline: purged on next read.
    advance(1); // now = 2000 >= 2000
    expect(await store.read(entry.id)).toBeNull();
    expect(await store.count()).toBe(0);
  });

  it('query() purges entries whose TTL elapsed under the injected clock', async () => {
    const { clock, advance } = fakeClock(1_000);
    const store = createInMemoryStore({ clock });
    await store.setWithTtl!('a', '1', 500);
    await store.setWithTtl!('b', '2', 5_000);

    advance(600); // a expired (deadline 1500), b alive (deadline 6000)
    const results = await store.query({});
    expect(results.map((r) => r.key)).toEqual(['b']);
  });

  it('defaults to the system clock when no clock is injected', async () => {
    const store = createInMemoryStore();
    const before = Date.now();
    const entry = await store.write({ key: 'k', content: 'c', grade: 'useful' });
    const after = Date.now();
    expect(entry.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt).toBeLessThanOrEqual(after);
  });
});
