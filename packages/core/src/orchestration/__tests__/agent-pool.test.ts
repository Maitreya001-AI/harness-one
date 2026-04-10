import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../core/agent-loop.js';
import { HarnessError } from '../../core/errors.js';
import { createAgentPool } from '../agent-pool.js';
import type { PoolConfig } from '../types.js';

const mockFactory = (_role?: string) =>
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

  it('dispose() clears all timers and disposes all loops', () => {
    pool = makePool({ idleTimeout: 60000 });
    const a1 = pool.acquire();
    const a2 = pool.acquire();
    pool.release(a1);
    pool.release(a2);

    pool.dispose();
    expect(a1.loop.status).toBe('disposed');
    expect(a2.loop.status).toBe('disposed');
    expect(pool.stats.total).toBe(0);
  });

  it('stats reflects correct idle/active/total counts', () => {
    pool = makePool();
    expect(pool.stats).toEqual({ idle: 0, active: 0, total: 0, created: 0, recycled: 0 });

    const a1 = pool.acquire();
    expect(pool.stats).toMatchObject({ idle: 0, active: 1, total: 1, created: 1 });

    const a2 = pool.acquire();
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
});
