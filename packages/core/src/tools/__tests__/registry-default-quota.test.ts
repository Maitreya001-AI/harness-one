/**
 * T08: createRegistry default-value flip.
 *
 * Production-grade defaults:
 *   - maxCallsPerTurn:    20        (was Infinity)
 *   - maxCallsPerSession: 100       (was Infinity)
 *   - timeoutMs:          30_000 ms (was undefined — no timeout)
 *
 * Callers can still opt out by passing Infinity / a custom value.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry.js';
import { defineTool } from '../define-tool.js';
import { toolSuccess } from '../types.js';

function makeEchoTool(name = 'echo') {
  return defineTool<{ text: string }>({
    name,
    description: `Echoes input (${name})`,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute: async (params) => toolSuccess(params.text),
  });
}

describe('T08: createRegistry default quota & timeout', () => {
  describe('default maxCallsPerTurn = 20', () => {
    it('allows exactly 20 calls per turn, rejects the 21st with a per-turn error', async () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      const call = { id: '1', name: 'echo', arguments: '{"text":"hi"}' };

      // 20 successful calls
      for (let i = 0; i < 20; i++) {
        const ok = await registry.execute(call);
        expect(ok.success).toBe(true);
      }

      // 21st must fail with per-turn message
      const blocked = await registry.execute(call);
      expect(blocked.success).toBe(false);
      if (!blocked.success) {
        expect(blocked.error.category).toBe('validation');
        expect(blocked.error.message).toMatch(/max calls per turn/i);
      }
    });

    it('explicit Infinity override disables the per-turn cap', async () => {
      const registry = createRegistry({ maxCallsPerTurn: Infinity });
      registry.register(makeEchoTool());
      const call = { id: '1', name: 'echo', arguments: '{"text":"hi"}' };

      // 25 calls should all succeed even though default cap would block at 21
      for (let i = 0; i < 25; i++) {
        const ok = await registry.execute(call);
        expect(ok.success).toBe(true);
      }
    });

    it('numeric override takes precedence over the 20 default', async () => {
      const registry = createRegistry({ maxCallsPerTurn: 3 });
      registry.register(makeEchoTool());
      const call = { id: '1', name: 'echo', arguments: '{"text":"hi"}' };

      await registry.execute(call);
      await registry.execute(call);
      await registry.execute(call);
      const fourth = await registry.execute(call);
      expect(fourth.success).toBe(false);
      if (!fourth.success) {
        expect(fourth.error.message).toMatch(/per turn/i);
      }
    });
  });

  describe('default maxCallsPerSession = 100', () => {
    it('rejects the 101st session call (across turn resets)', async () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      const call = { id: '1', name: 'echo', arguments: '{"text":"hi"}' };

      // 100 calls spread over 5 turns of 20 calls each (reset turn counter,
      // session counter keeps accumulating)
      for (let turn = 0; turn < 5; turn++) {
        for (let i = 0; i < 20; i++) {
          const ok = await registry.execute(call);
          expect(ok.success).toBe(true);
        }
        registry.resetTurn();
      }

      // The 101st must be session-blocked
      const blocked = await registry.execute(call);
      expect(blocked.success).toBe(false);
      if (!blocked.success) {
        expect(blocked.error.category).toBe('validation');
        expect(blocked.error.message).toMatch(/per session/i);
      }
    });

    it('explicit Infinity override disables the per-session cap', async () => {
      const registry = createRegistry({
        maxCallsPerTurn: Infinity,
        maxCallsPerSession: Infinity,
      });
      registry.register(makeEchoTool());
      const call = { id: '1', name: 'echo', arguments: '{"text":"hi"}' };

      for (let i = 0; i < 150; i++) {
        const ok = await registry.execute(call);
        expect(ok.success).toBe(true);
      }
    });
  });

  describe('default timeoutMs = 30_000', () => {
    it('exposes the resolved default via getConfig()', () => {
      const registry = createRegistry();
      const cfg = registry.getConfig();
      expect(cfg.timeoutMs).toBe(30_000);
      expect(cfg.maxCallsPerTurn).toBe(20);
      expect(cfg.maxCallsPerSession).toBe(100);
    });

    it('honors explicit timeoutMs override', () => {
      const registry = createRegistry({ timeoutMs: 500 });
      expect(registry.getConfig().timeoutMs).toBe(500);
    });

    it('timeout is enforced by default (fast tool succeeds)', async () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      const result = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hi"}',
      });
      // Echo is synchronous; default 30s timeout must not kick in.
      expect(result.success).toBe(true);
    });
  });
});
