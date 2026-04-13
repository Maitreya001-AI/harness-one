import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../core/agent-loop.js';
import { HarnessError } from '../../core/errors.js';
import { createAgentPool } from '../agent-pool.js';
import type { PoolConfig } from '../types.js';

const mockFactory = () =>
  new AgentLoop({
    adapter: {
      async chat() {
        return {
          message: { role: 'assistant' as const, content: 'ok' },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  });

function makePool(overrides: Partial<PoolConfig> = {}) {
  return createAgentPool({ factory: mockFactory, ...overrides });
}

describe('AgentPool', () => {
  let pool: ReturnType<typeof createAgentPool>;

  afterEach(() => {
    pool?.dispose();
  });

  it('acquire() returns a PooledAgent with a valid AgentLoop', () => {
    pool = makePool();
    const agent = pool.acquire();
    expect(agent.id).toBeDefined();
    expect(agent.loop).toBeInstanceOf(AgentLoop);
    expect(agent.createdAt).toBeGreaterThan(0);
  });

  it('release() returns agent to idle state', () => {
    pool = makePool();
    const agent = pool.acquire();
    expect(pool.stats.active).toBe(1);
    expect(pool.stats.idle).toBe(0);

    pool.release(agent);
    expect(pool.stats.active).toBe(0);
    expect(pool.stats.idle).toBe(1);
  });

  it('acquire() reuses idle agents', () => {
    pool = makePool();
    const agent1 = pool.acquire();
    const id1 = agent1.id;
    pool.release(agent1);

    const agent2 = pool.acquire();
    expect(agent2.id).toBe(id1);
    expect(pool.stats.total).toBe(1);
  });

  it('acquire() throws POOL_EXHAUSTED when at max', () => {
    pool = makePool({ max: 1 });
    pool.acquire();

    expect(() => pool.acquire()).toThrow(HarnessError);
    try {
      pool.acquire();
    } catch (err) {
      expect((err as HarnessError).code).toBe('POOL_EXHAUSTED');
    }
  });

  it('acquire() throws POOL_DISPOSED after dispose', () => {
    pool = makePool();
    pool.dispose();

    expect(() => pool.acquire()).toThrow(HarnessError);
    try {
      pool.acquire();
    } catch (err) {
      expect((err as HarnessError).code).toBe('POOL_DISPOSED');
    }
  });

  it('release() is idempotent (double-release does not throw)', () => {
    pool = makePool();
    const agent = pool.acquire();
    pool.release(agent);
    expect(() => pool.release(agent)).not.toThrow();
    expect(pool.stats.idle).toBe(1);
  });

  it('dispose() clears all timers and disposes all loops', async () => {
    pool = makePool({ idleTimeout: 60000 });
    const a1 = pool.acquire();
    const a2 = pool.acquire();
    pool.release(a1);
    pool.release(a2);

    // LM-014: dispose is now async — await so loop.dispose() settles before
    // the assertion runs.
    await pool.dispose();
    expect(a1.loop.status).toBe('disposed');
    expect(a2.loop.status).toBe('disposed');
    expect(pool.stats.total).toBe(0);
  });

  it('stats reflects correct idle/active/total counts', () => {
    pool = makePool();
    expect(pool.stats).toEqual({ idle: 0, active: 0, total: 0, created: 0, recycled: 0 });

    const a1 = pool.acquire();
    expect(pool.stats).toMatchObject({ idle: 0, active: 1, total: 1, created: 1 });

    pool.acquire();
    expect(pool.stats).toMatchObject({ idle: 0, active: 2, total: 2, created: 2 });

    pool.release(a1);
    expect(pool.stats).toMatchObject({ idle: 1, active: 1, total: 2 });
  });

  it('drain() waits for active agents then disposes', async () => {
    pool = makePool();
    const agent = pool.acquire();

    const drainPromise = pool.drain();

    // Release after a short delay
    setTimeout(() => pool.release(agent), 100);

    await drainPromise;
    expect(pool.stats.total).toBe(0);
  });

  it('lazy warm-up: min agents created on first acquire', () => {
    pool = makePool({ min: 3 });
    // Before first acquire, nothing created
    expect(pool.stats.total).toBe(0);

    pool.acquire();
    // After first acquire, min agents should be warm (including the acquired one)
    expect(pool.stats.total).toBe(3);
    expect(pool.stats.active).toBe(1);
    expect(pool.stats.idle).toBe(2);
  });

  it('drain() resolves after timeout even with unreleased agents', async () => {
    pool = makePool({ max: 5 });
    pool.acquire(); // never released
    await pool.drain(200); // should resolve in ~200ms, not hang
    expect(pool.stats.total).toBe(0); // all disposed
  });

  it('two independent pools have isolated ID counters', () => {
    const pool1 = makePool({ max: 5 });
    const pool2 = makePool({ max: 5 });
    const a1 = pool1.acquire();
    const a2 = pool2.acquire();
    // Both should start from 1 (isolated counters)
    expect(a1.id).toBe(a2.id);
    pool1.dispose();
    pool2.dispose();
    pool = makePool(); // keep afterEach happy
  });

  it('expired agents are recycled on release when maxAge is set', () => {
    vi.useFakeTimers();
    try {
      pool = makePool({ max: 5, maxAge: 100 });
      const agent = pool.acquire();
      vi.advanceTimersByTime(150);
      pool.release(agent);
      expect(pool.stats.idle).toBe(0); // disposed, not returned to idle
    } finally {
      vi.useRealTimers();
    }
  });

  it('acquire() skips expired idle agents', () => {
    vi.useFakeTimers();
    try {
      pool = makePool({ max: 5, maxAge: 100 });
      const agent = pool.acquire();
      pool.release(agent); // returns to idle
      vi.advanceTimersByTime(150); // now expired
      const agent2 = pool.acquire(); // should skip expired, create new
      expect(agent2.id).not.toBe(agent.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('PooledAgent is frozen', () => {
    pool = makePool();
    const agent = pool.acquire();
    expect(Object.isFrozen(agent)).toBe(true);
  });

  it('resize() trims idle agents down to target', () => {
    pool = makePool({ max: 10 });
    const a1 = pool.acquire();
    const a2 = pool.acquire();
    const a3 = pool.acquire();
    pool.release(a1);
    pool.release(a2);
    pool.release(a3);
    expect(pool.stats.idle).toBe(3);

    pool.resize(1);
    expect(pool.stats.total).toBe(1);
    expect(pool.stats.idle).toBe(1);
  });

  it('resize() pre-warms up to target', () => {
    pool = makePool({ max: 10 });
    expect(pool.stats.total).toBe(0);

    pool.resize(3);
    expect(pool.stats.total).toBe(3);
    expect(pool.stats.idle).toBe(3);
    expect(pool.stats.active).toBe(0);
  });

  it('resize() does not exceed max', () => {
    pool = makePool({ max: 2 });
    pool.resize(5);
    expect(pool.stats.total).toBe(2);
  });

  it('timer leak prevention: after dispose, no pending timers', () => {
    vi.useFakeTimers();
    try {
      pool = makePool({ idleTimeout: 5000 });
      const agent = pool.acquire();
      pool.release(agent); // starts idle timer

      pool.dispose();

      // Advancing timers should not cause errors
      vi.advanceTimersByTime(10000);
      expect(pool.stats.total).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Fix 24: Async acquire queue
  describe('acquireAsync (Fix 24)', () => {
    it('acquires immediately when pool has capacity', async () => {
      pool = makePool({ max: 5 });
      const agent = await pool.acquireAsync();
      expect(agent).toBeDefined();
      expect(agent.loop).toBeDefined();
    });

    it('queues request and fulfills when agent released', async () => {
      pool = makePool({ max: 1 });
      const agent1 = pool.acquire();

      // Start async acquire - should queue
      const acquirePromise = pool.acquireAsync(5000);

      // Release agent1 - should fulfill the pending request
      setTimeout(() => pool.release(agent1), 50);

      const agent2 = await acquirePromise;
      expect(agent2).toBeDefined();
    });

    it('rejects with POOL_TIMEOUT when timeout expires', async () => {
      pool = makePool({ max: 1 });
      pool.acquire(); // exhaust pool

      await expect(pool.acquireAsync(100)).rejects.toThrow(HarnessError);
      try {
        await pool.acquireAsync(100);
      } catch (e) {
        expect((e as HarnessError).code).toBe('POOL_TIMEOUT');
      }
    });

    it('rejects with POOL_DISPOSED when pool is disposed', async () => {
      pool = makePool();
      pool.dispose();

      await expect(pool.acquireAsync()).rejects.toThrow(HarnessError);
    });
  });

  // CQ-017: AbortSignal support for acquireAsync
  describe('CQ-017: acquireAsync AbortSignal', () => {
    it('rejects synchronously when signal is already aborted', async () => {
      pool = makePool();
      const ac = new AbortController();
      ac.abort();
      await expect(pool.acquireAsync({ signal: ac.signal })).rejects.toMatchObject({ code: 'POOL_ABORTED' });
    });

    it('rejects with POOL_ABORTED when signal aborts while pending, and removes from queue', async () => {
      pool = makePool({ max: 1 });
      pool.acquire(); // exhaust pool

      const ac = new AbortController();
      const promise = pool.acquireAsync({ timeoutMs: 10_000, signal: ac.signal });

      // Abort shortly after queueing.
      setTimeout(() => ac.abort(), 20);

      await expect(promise).rejects.toMatchObject({ code: 'POOL_ABORTED' });

      // Subsequent acquireAsync can still be queued (entry was removed cleanly).
      const ac2 = new AbortController();
      setTimeout(() => ac2.abort(), 10);
      await expect(pool.acquireAsync({ timeoutMs: 5000, signal: ac2.signal })).rejects.toMatchObject({ code: 'POOL_ABORTED' });
    });

    it('accepts legacy numeric timeoutMs argument', async () => {
      pool = makePool({ max: 1 });
      pool.acquire();
      await expect(pool.acquireAsync(50)).rejects.toMatchObject({ code: 'POOL_TIMEOUT' });
    });

    it('does not invoke abort listener after successful resolution', async () => {
      pool = makePool({ max: 1 });
      const first = pool.acquire();
      const ac = new AbortController();
      const promise = pool.acquireAsync({ timeoutMs: 5000, signal: ac.signal });
      setTimeout(() => pool.release(first), 20);
      const acquired = await promise;
      expect(acquired).toBeDefined();
      // Aborting after resolution should be a no-op (no unhandled rejection).
      ac.abort();
    });
  });

  // LM-014: async idempotent dispose that awaits loop.dispose
  describe('LM-014: async idempotent dispose', () => {
    it('awaits every loop.dispose() so all loops report disposed', async () => {
      pool = makePool({ max: 3 });
      const a = pool.acquire();
      const b = pool.acquire();
      const c = pool.acquire();
      pool.release(a);
      pool.release(b);
      pool.release(c);
      await pool.dispose();
      expect(a.loop.status).toBe('disposed');
      expect(b.loop.status).toBe('disposed');
      expect(c.loop.status).toBe('disposed');
    });

    it('concurrent dispose() calls share the same latch', async () => {
      pool = makePool({ max: 3 });
      const a = pool.acquire();
      pool.release(a);
      const p1 = pool.dispose();
      const p2 = pool.dispose();
      const p3 = pool.dispose();
      // All three resolve to the same underlying teardown.
      await Promise.all([p1, p2, p3]);
      expect(a.loop.status).toBe('disposed');
      expect(pool.stats.total).toBe(0);
    });

    it('rejects pending queued acquires on dispose with POOL_DISPOSED', async () => {
      pool = makePool({ max: 1 });
      pool.acquire(); // exhaust
      const pending = pool.acquireAsync(10_000);
      const disposal = pool.dispose();
      await expect(pending).rejects.toMatchObject({ code: 'POOL_DISPOSED' });
      await disposal;
    });

    it('subsequent dispose() calls after completion return a resolved promise', async () => {
      pool = makePool();
      await pool.dispose();
      // Second call must not throw, resolve cleanly, and not revisit teardown.
      await expect(pool.dispose()).resolves.toBeUndefined();
    });
  });
});
