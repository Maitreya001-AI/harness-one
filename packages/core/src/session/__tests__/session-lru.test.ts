/**
 * Unit tests for the extracted session LRU helper. Pins the
 * lock-aware access-order + amortised eviction behaviour.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSessionLru } from '../session-lru.js';

function makeLru(max: number) {
  const evicted: string[] = [];
  const lru = createSessionLru<string>({
    maxSessions: max,
    callbacks: { onEvict: (id) => { evicted.push(id); } },
  });
  return { lru, evicted };
}

describe('createSessionLru', () => {
  it('insertUnlocked places ids at the tail', () => {
    const { lru } = makeLru(10);
    lru.insertUnlocked('a');
    lru.insertUnlocked('b');
    expect(lru.unlockedSize()).toBe(2);
  });

  it('touchAccessOrder moves an unlocked id to the tail (evicts older first)', () => {
    const { lru, evicted } = makeLru(2);
    lru.insertUnlocked('a');
    lru.insertUnlocked('b');
    lru.touchAccessOrder('a'); // order is now b, a (a is newest)
    lru.insertUnlocked('c');   // order is now b, a, c

    // maxSessions=2, threshold=1 (5% ⇒ min 1). evictExcess only fires when
    // remaining > 3. Simulate remaining=4 so the loop evicts back to cap=2.
    // That means 2 evictions, popping from head: 'b', then 'a'. 'a' was
    // NOT the first to go because touchAccessOrder moved it to the tail.
    lru.evictExcess(4);
    expect(evicted[0]).toBe('b');
    expect(evicted.length).toBe(2);
  });

  it('markLocked removes from unlocked tracking', () => {
    const { lru } = makeLru(10);
    lru.insertUnlocked('a');
    lru.markLocked('a');
    expect(lru.isLocked('a')).toBe(true);
    expect(lru.unlockedSize()).toBe(0);
  });

  it('markUnlocked restores an id at the tail', () => {
    const { lru } = makeLru(10);
    lru.insertUnlocked('a');
    lru.insertUnlocked('b');
    lru.markLocked('b');
    lru.markUnlocked('b');
    expect(lru.isLocked('b')).toBe(false);
    expect(lru.unlockedSize()).toBe(2);
  });

  it('touchAccessOrder is a no-op for locked ids', () => {
    const { lru } = makeLru(10);
    lru.insertUnlocked('a');
    lru.markLocked('a');
    lru.touchAccessOrder('a');
    expect(lru.unlockedSize()).toBe(0);
  });

  it('evictExcess amortises — no eviction until threshold breached', () => {
    const { lru, evicted } = makeLru(100);
    for (let i = 0; i < 100; i++) lru.insertUnlocked(`s${i}`);
    lru.evictExcess(100);
    expect(evicted).toEqual([]);
    // threshold is 5% of 100 = 5. 105 is the ceiling; evictExcess should
    // only kick in strictly above it.
    lru.evictExcess(105);
    expect(evicted).toEqual([]);
    lru.evictExcess(106);
    // Evicts back down to maxSessions (100) — we've just shown 6 excess, but
    // the LRU only knows about 100 unlocked ids, so it evicts until back at cap.
    expect(evicted.length).toBeGreaterThanOrEqual(1);
  });

  it('remove purges locked and unlocked ids', () => {
    const { lru } = makeLru(10);
    lru.insertUnlocked('a');
    lru.markLocked('a');
    lru.remove('a');
    expect(lru.isLocked('a')).toBe(false);
    expect(lru.unlockedSize()).toBe(0);
  });

  it('clear wipes both tracking structures', () => {
    const { lru } = makeLru(10);
    lru.insertUnlocked('a');
    lru.markLocked('b'); // previously locked without being in unlocked
    lru.clear();
    expect(lru.unlockedSize()).toBe(0);
    expect(lru.isLocked('b')).toBe(false);
  });

  it('onEvict callback is invoked with the evicted id', () => {
    const onEvict = vi.fn();
    const lru = createSessionLru<string>({
      maxSessions: 1,
      callbacks: { onEvict },
    });
    lru.insertUnlocked('a');
    lru.insertUnlocked('b');
    // evictExcess(3) fires because 3 > 1 + threshold(1) = 2.
    lru.evictExcess(3);
    expect(onEvict).toHaveBeenCalledWith('a');
  });
});
