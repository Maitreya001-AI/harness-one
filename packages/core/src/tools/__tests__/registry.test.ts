import { describe, it, expect, vi } from 'vitest';
import { createRegistry } from '../registry.js';
import { defineTool } from '../define-tool.js';
import { toolSuccess } from '../types.js';
import type { ToolResult } from '../types.js';

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

describe('createRegistry', () => {
  describe('register', () => {
    it('registers a tool', () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      expect(registry.get('echo')).toBeDefined();
    });

    it('rejects invalid tool names', () => {
      const registry = createRegistry();
      const tool = defineTool({
        name: '123bad',
        description: 'bad',
        parameters: { type: 'object' },
        execute: async () => toolSuccess(null),
      });
      expect(() => registry.register(tool)).toThrow('Invalid tool name');
    });

    it('rejects duplicate registrations', () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      expect(() => registry.register(makeEchoTool())).toThrow('already registered');
    });

    it('accepts dotted names', () => {
      const registry = createRegistry();
      registry.register(makeEchoTool('fs.readFile'));
      expect(registry.get('fs.readFile')).toBeDefined();
    });

    it('F21: accepts underscored names', () => {
      const registry = createRegistry();
      registry.register(makeEchoTool('my_tool'));
      expect(registry.get('my_tool')).toBeDefined();
    });

    it('F21: accepts names with dots and underscores combined', () => {
      const registry = createRegistry();
      registry.register(makeEchoTool('ns.my_tool'));
      expect(registry.get('ns.my_tool')).toBeDefined();
    });
  });

  describe('get', () => {
    it('returns undefined for unregistered tools', () => {
      const registry = createRegistry();
      expect(registry.get('nope')).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns all tools when no namespace', () => {
      const registry = createRegistry();
      registry.register(makeEchoTool('a'));
      registry.register(makeEchoTool('b'));
      expect(registry.list()).toHaveLength(2);
    });

    it('filters by namespace prefix', () => {
      const registry = createRegistry();
      registry.register(makeEchoTool('fs.read'));
      registry.register(makeEchoTool('fs.write'));
      registry.register(makeEchoTool('net.fetch'));
      expect(registry.list('fs')).toHaveLength(2);
      expect(registry.list('net')).toHaveLength(1);
      expect(registry.list('db')).toHaveLength(0);
    });
  });

  describe('schemas', () => {
    it('returns tool schemas for LLM', () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      const s = registry.schemas();
      expect(s).toHaveLength(1);
      expect(s[0].name).toBe('echo');
      expect(s[0].description).toBe('Echoes input (echo)');
      expect(s[0].parameters.type).toBe('object');
    });

    it('includes responseFormat in schemas when defined on tool', () => {
      const registry = createRegistry();
      const tool = defineTool<{ text: string }>({
        name: 'search',
        description: 'Search tool',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        responseFormat: 'detailed',
        execute: async (params) => toolSuccess(params.text),
      });
      registry.register(tool);
      const s = registry.schemas();
      expect(s).toHaveLength(1);
      expect(s[0].responseFormat).toBe('detailed');
    });

    it('omits responseFormat from schemas when not defined on tool', () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      const s = registry.schemas();
      expect(s[0].responseFormat).toBeUndefined();
    });
  });

  describe('execute', () => {
    it('executes a tool call successfully', async () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      const result = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      expect(result).toEqual({ kind: 'success', success: true, data: 'hello' });
    });

    it('returns not_found for unknown tool', async () => {
      const registry = createRegistry();
      const result = await registry.execute({
        id: '1',
        name: 'missing',
        arguments: '{}',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('not_found');
      }
    });

    it('returns error for invalid JSON arguments', async () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      const result = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: 'not json',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('validation');
        expect(result.error.message).toContain('Invalid JSON');
      }
    });

    it('returns validation error for invalid params', async () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      const result = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text": 123}',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('validation');
        expect(result.error.message).toContain('Validation failed');
      }
    });

    it('enforces per-turn rate limit', async () => {
      const registry = createRegistry({ maxCallsPerTurn: 2 });
      registry.register(makeEchoTool());
      const call = { id: '1', name: 'echo', arguments: '{"text":"hi"}' };

      await registry.execute(call);
      await registry.execute(call);
      const result = await registry.execute(call);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('validation');
        expect(result.error.message).toContain('per turn');
      }
    });

    it('enforces per-session rate limit', async () => {
      const registry = createRegistry({ maxCallsPerSession: 1 });
      registry.register(makeEchoTool());
      const call = { id: '1', name: 'echo', arguments: '{"text":"hi"}' };

      await registry.execute(call);
      const result = await registry.execute(call);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('validation');
        expect(result.error.message).toContain('per session');
      }
    });
  });

  describe('resetTurn', () => {
    it('resets the per-turn counter', async () => {
      const registry = createRegistry({ maxCallsPerTurn: 1 });
      registry.register(makeEchoTool());
      const call = { id: '1', name: 'echo', arguments: '{"text":"hi"}' };

      await registry.execute(call);
      // Should fail now
      const fail = await registry.execute(call);
      expect(fail.success).toBe(false);

      // Reset and try again
      registry.resetTurn();
      const pass = await registry.execute(call);
      expect(pass.success).toBe(true);
    });
  });

  describe('resetSession', () => {
    it('resets both session and turn counters', async () => {
      const registry = createRegistry({ maxCallsPerSession: 2, maxCallsPerTurn: 5 });
      registry.register(makeEchoTool());
      const call = { id: '1', name: 'echo', arguments: '{"text":"hi"}' };

      // Use up the session limit
      await registry.execute(call);
      await registry.execute(call);
      const blocked = await registry.execute(call);
      expect(blocked.success).toBe(false);
      if (!blocked.success) {
        expect(blocked.error.message).toContain('per session');
      }

      // Reset session and verify both counters are cleared
      registry.resetSession();
      const pass = await registry.execute(call);
      expect(pass.success).toBe(true);
    });

    it('also resets turn counter when session is reset', async () => {
      const registry = createRegistry({ maxCallsPerTurn: 1, maxCallsPerSession: 10 });
      registry.register(makeEchoTool());
      const call = { id: '1', name: 'echo', arguments: '{"text":"hi"}' };

      await registry.execute(call);
      // Turn limit reached
      const turnBlocked = await registry.execute(call);
      expect(turnBlocked.success).toBe(false);

      // resetSession should also reset turn counter
      registry.resetSession();
      const pass = await registry.execute(call);
      expect(pass.success).toBe(true);
    });
  });

  describe('C6: permission validation', () => {
    it('blocks execution when permissions.check returns false', async () => {
      const registry = createRegistry({
        permissions: {
          check: (toolName: string) => toolName !== 'echo',
        },
      });
      registry.register(makeEchoTool());
      const result = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('permission');
        expect(result.error.message).toContain('Permission denied');
      }
    });

    it('allows execution when permissions.check returns true', async () => {
      const registry = createRegistry({
        permissions: {
          check: () => true,
        },
      });
      registry.register(makeEchoTool());
      const result = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      expect(result.success).toBe(true);
    });

    it('passes context with parsed params to permissions.check', async () => {
      const checkFn = vi.fn().mockReturnValue(true);
      const registry = createRegistry({
        permissions: { check: checkFn },
      });
      registry.register(makeEchoTool());
      await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      expect(checkFn).toHaveBeenCalledWith('echo', {
        toolCallId: '1',
        params: { text: 'hello' },
      });
    });

    it('enables parameter-based authorization via permissions.check', async () => {
      const registry = createRegistry({
        permissions: {
          check: (_name: string, context?: Record<string, unknown>) => {
            const params = context?.params as { text?: string } | undefined;
            // Block calls with text "forbidden"
            return params?.text !== 'forbidden';
          },
        },
      });
      registry.register(makeEchoTool());

      const allowed = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      expect(allowed.success).toBe(true);

      const blocked = await registry.execute({
        id: '2',
        name: 'echo',
        arguments: '{"text":"forbidden"}',
      });
      expect(blocked.success).toBe(false);
      if (!blocked.success) {
        expect(blocked.error.category).toBe('permission');
      }
    });

    it('executes without permissions config (backward compatible)', async () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      const result = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('H1: timeout support', () => {
    it('times out a slow tool execution', async () => {
      const slowTool = defineTool({
        name: 'slow',
        description: 'Slow tool',
        parameters: { type: 'object' },
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return toolSuccess('done');
        },
      });
      const registry = createRegistry({ timeoutMs: 50 });
      registry.register(slowTool);
      const result = await registry.execute({
        id: '1',
        name: 'slow',
        arguments: '{}',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('timeout');
        expect(result.error.message).toContain('timed out');
      }
    });

    it('does not time out a fast tool execution', async () => {
      const registry = createRegistry({ timeoutMs: 5000 });
      registry.register(makeEchoTool());
      const result = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      expect(result.success).toBe(true);
    });

    it('works without timeoutMs (backward compatible)', async () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      const result = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      expect(result.success).toBe(true);
    });

    it('clears timeout timer after successful execution', async () => {
      vi.useFakeTimers();
      const registry = createRegistry({ timeoutMs: 5000 });
      registry.register(makeEchoTool());
      const promise = registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      // Fast-forward past tool execution (echo resolves immediately)
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;
      expect(result.success).toBe(true);

      // Advancing timers past timeout should not cause issues
      // (timer was cleared via finally block)
      await vi.advanceTimersByTimeAsync(10000);
      vi.useRealTimers();
    });

    it('passes abort signal to tool.execute on timeout', async () => {
      let receivedSignal: AbortSignal | undefined;
      const slowTool = defineTool({
        name: 'abortable',
        description: 'Abortable tool',
        parameters: { type: 'object' },
        execute: async (_params, signal) => {
          receivedSignal = signal;
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return toolSuccess('done');
        },
      });
      const registry = createRegistry({ timeoutMs: 50 });
      registry.register(slowTool);
      const result = await registry.execute({
        id: '1',
        name: 'abortable',
        arguments: '{}',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('timeout');
      }
      // The signal should have been passed and aborted
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal!.aborted).toBe(true);
    });
  });

  describe('TOCTOU rate-limit fix', () => {
    it('concurrent execute() calls respect maxCallsPerTurn', async () => {
      // Tool that yields the event loop to simulate async work
      const asyncTool = defineTool({
        name: 'slow',
        description: 'Async tool',
        parameters: { type: 'object' },
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return toolSuccess('ok');
        },
      });
      const registry = createRegistry({ maxCallsPerTurn: 1 });
      registry.register(asyncTool);

      const call = { id: '1', name: 'slow', arguments: '{}' };
      // Launch 5 concurrent calls — only 1 should succeed
      const results = await Promise.all([
        registry.execute(call),
        registry.execute(call),
        registry.execute(call),
        registry.execute(call),
        registry.execute(call),
      ]);

      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(4);
    });

    it('releases rate-limit slot on JSON parse failure', async () => {
      const registry = createRegistry({ maxCallsPerTurn: 1 });
      registry.register(makeEchoTool());

      // Invalid JSON should NOT consume a slot
      const bad = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: 'not json',
      });
      expect(bad.success).toBe(false);

      // Valid call should still succeed (slot was released)
      const good = await registry.execute({
        id: '2',
        name: 'echo',
        arguments: '{"text":"hi"}',
      });
      expect(good.success).toBe(true);
    });

    it('releases rate-limit slot on tool-not-found', async () => {
      const registry = createRegistry({ maxCallsPerTurn: 1 });
      registry.register(makeEchoTool());

      // Missing tool should NOT consume a slot
      const bad = await registry.execute({
        id: '1',
        name: 'missing',
        arguments: '{}',
      });
      expect(bad.success).toBe(false);

      const good = await registry.execute({
        id: '2',
        name: 'echo',
        arguments: '{"text":"hi"}',
      });
      expect(good.success).toBe(true);
    });

    it('releases rate-limit slot on validation failure', async () => {
      const registry = createRegistry({ maxCallsPerTurn: 1 });
      registry.register(makeEchoTool());

      // Invalid params should NOT consume a slot
      const bad = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text": 123}',
      });
      expect(bad.success).toBe(false);

      const good = await registry.execute({
        id: '2',
        name: 'echo',
        arguments: '{"text":"hi"}',
      });
      expect(good.success).toBe(true);
    });

    it('releases rate-limit slot on permission denied', async () => {
      let callCount = 0;
      const registry = createRegistry({
        maxCallsPerTurn: 1,
        permissions: {
          check: () => {
            callCount++;
            // Deny first call, allow second
            return callCount > 1;
          },
        },
      });
      registry.register(makeEchoTool());

      const bad = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hi"}',
      });
      expect(bad.success).toBe(false);

      const good = await registry.execute({
        id: '2',
        name: 'echo',
        arguments: '{"text":"hi"}',
      });
      expect(good.success).toBe(true);
    });

    it('does NOT release slot when tool.execute() fails', async () => {
      const failTool = defineTool({
        name: 'fail',
        description: 'Failing tool',
        parameters: { type: 'object' },
        execute: async () => ({ kind: 'error' as const, success: false as const, error: { message: 'boom', category: 'execution' as const } }),
      });
      const registry = createRegistry({ maxCallsPerTurn: 1 });
      registry.register(failTool);

      // Tool execution failure should still consume the slot
      await registry.execute({ id: '1', name: 'fail', arguments: '{}' });

      const blocked = await registry.execute({ id: '2', name: 'fail', arguments: '{}' });
      expect(blocked.success).toBe(false);
      if (!blocked.success) {
        expect(blocked.error.message).toContain('per turn');
      }
    });
  });

  describe('handler', () => {
    it('returns a function compatible with onToolCall', async () => {
      const registry = createRegistry();
      registry.register(makeEchoTool());
      const h = registry.handler();

      const result = await h({ id: '1', name: 'echo', arguments: '{"text":"hello"}' });
      expect(result).toBe('hello');
    });

    it('returns full result object on failure', async () => {
      const registry = createRegistry();
      const h = registry.handler();

      const result = (await h({ id: '1', name: 'missing', arguments: '{}' })) as ToolResult;
      expect(result.success).toBe(false);
    });
  });

  describe('Fix 6: TOCTOU atomic rate limiting', () => {
    it('concurrent calls cannot both pass the limit (atomic increment-then-check)', async () => {
      // With increment-first pattern, concurrent calls cannot both slip through
      const asyncTool = defineTool({
        name: 'async',
        description: 'Async tool',
        parameters: { type: 'object' },
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return toolSuccess('ok');
        },
      });
      const registry = createRegistry({ maxCallsPerTurn: 2 });
      registry.register(asyncTool);

      const call = { id: '1', name: 'async', arguments: '{}' };
      // Launch 5 concurrent calls - only 2 should succeed
      const results = await Promise.all([
        registry.execute(call),
        registry.execute(call),
        registry.execute(call),
        registry.execute(call),
        registry.execute(call),
      ]);

      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);
      expect(successes).toHaveLength(2);
      expect(failures).toHaveLength(3);
    });

    it('decrements counters on early failure paths (not_found, validation, permission)', async () => {
      const registry = createRegistry({ maxCallsPerTurn: 1 });
      registry.register(makeEchoTool());

      // Not found should not consume a slot
      await registry.execute({ id: '1', name: 'missing', arguments: '{}' });
      const good1 = await registry.execute({ id: '2', name: 'echo', arguments: '{"text":"hi"}' });
      expect(good1.success).toBe(true);

      registry.resetTurn();

      // Invalid JSON should not consume a slot
      await registry.execute({ id: '3', name: 'echo', arguments: 'not json' });
      const good2 = await registry.execute({ id: '4', name: 'echo', arguments: '{"text":"hi"}' });
      expect(good2.success).toBe(true);

      registry.resetTurn();

      // Validation failure should not consume a slot
      await registry.execute({ id: '5', name: 'echo', arguments: '{"text": 123}' });
      const good3 = await registry.execute({ id: '6', name: 'echo', arguments: '{"text":"hi"}' });
      expect(good3.success).toBe(true);
    });
  });

  describe('Fix 7: Timer listener leak prevention', () => {
    it('cleans up timeout timer on successful execution (no leaked timers)', async () => {
      vi.useFakeTimers();
      const registry = createRegistry({ timeoutMs: 5000 });
      registry.register(makeEchoTool());
      const promise = registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;
      expect(result.success).toBe(true);

      // Advancing timers past timeout should not cause any issues
      // because the timer was properly cleared in the finally block
      await vi.advanceTimersByTimeAsync(10000);
      vi.useRealTimers();
    });

    it('does not leak abort signal listeners after timeout', async () => {
      const slowTool = defineTool({
        name: 'slow',
        description: 'Slow tool',
        parameters: { type: 'object' },
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return toolSuccess('done');
        },
      });
      const registry = createRegistry({ timeoutMs: 50 });
      registry.register(slowTool);

      // Execute multiple times to verify no listener accumulation
      for (let i = 0; i < 10; i++) {
        const result = await registry.execute({
          id: String(i),
          name: 'slow',
          arguments: '{}',
        });
        expect(result.success).toBe(false);
      }
      // If listeners leaked, we'd see a Node.js MaxListenersExceeded warning
      // The test passing without error means no leak
    });
  });

  describe('edge cases', () => {
    it('permission check blocks execution', async () => {
      const registry = createRegistry({
        permissions: {
          check: (toolName: string) => toolName !== 'echo',
        },
      });
      registry.register(makeEchoTool());
      const result = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('permission');
      }
    });

    it('permission check allows execution', async () => {
      const registry = createRegistry({
        permissions: {
          check: () => true,
        },
      });
      registry.register(makeEchoTool());
      const result = await registry.execute({
        id: '1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      });
      expect(result.success).toBe(true);
    });

    it('timeout: tool exceeds timeoutMs — returns timeout error', async () => {
      const slowTool = defineTool({
        name: 'slow',
        description: 'Slow tool',
        parameters: { type: 'object' },
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return toolSuccess('done');
        },
      });
      const registry = createRegistry({ timeoutMs: 30 });
      registry.register(slowTool);
      const result = await registry.execute({
        id: '1',
        name: 'slow',
        arguments: '{}',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('timeout');
        expect(result.error.retryable).toBe(true);
      }
    });

    it('execute tool with empty arguments string (valid empty object)', async () => {
      const registry = createRegistry();
      const noArgTool = defineTool({
        name: 'ping',
        description: 'Ping tool',
        parameters: { type: 'object' },
        execute: async () => toolSuccess('pong'),
      });
      registry.register(noArgTool);
      const result = await registry.execute({
        id: '1',
        name: 'ping',
        arguments: '{}',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('pong');
      }
    });

    it('list tools by namespace prefix', () => {
      const registry = createRegistry();
      registry.register(makeEchoTool('fs.read'));
      registry.register(makeEchoTool('fs.write'));
      registry.register(makeEchoTool('fs.delete'));
      registry.register(makeEchoTool('net.fetch'));
      registry.register(makeEchoTool('net.post'));

      const fsTools = registry.list('fs');
      expect(fsTools).toHaveLength(3);
      expect(fsTools.every(t => t.name.startsWith('fs.'))).toBe(true);

      const netTools = registry.list('net');
      expect(netTools).toHaveLength(2);

      const dbTools = registry.list('db');
      expect(dbTools).toHaveLength(0);
    });

    it('schemas include responseFormat when defined', () => {
      const registry = createRegistry();
      const tool = defineTool<{ text: string }>({
        name: 'search',
        description: 'Search tool',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        responseFormat: 'concise',
        execute: async (params) => toolSuccess(params.text),
      });
      registry.register(tool);
      registry.register(makeEchoTool());
      const s = registry.schemas();
      const searchSchema = s.find(sc => sc.name === 'search');
      const echoSchema = s.find(sc => sc.name === 'echo');
      expect(searchSchema!.responseFormat).toBe('concise');
      expect(echoSchema!.responseFormat).toBeUndefined();
    });
  });

  // CQ-008: timeout branch must convert a throwing tool.execute() into a
  // toolError reply (same as the non-timeout path), not propagate.
  describe('CQ-008: timeout branch error conversion', () => {
    it('converts a thrown Error into a toolError with internal category', async () => {
      const registry = createRegistry({ timeoutMs: 5000 });
      registry.register({
        name: 'throws',
        description: 'always throws synchronously',
        parameters: { type: 'object' },
        execute: async () => { throw new Error('boom from tool'); },
      });
      const result = await registry.execute({ id: '1', name: 'throws', arguments: '{}' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('internal');
        expect(result.error.message).toContain('boom');
      }
    });

    it('converts a rejected Promise into a toolError with internal category', async () => {
      const registry = createRegistry({ timeoutMs: 5000 });
      registry.register({
        name: 'rejects',
        description: 'always rejects',
        parameters: { type: 'object' },
        execute: async () => Promise.reject(new Error('async boom')),
      });
      const result = await registry.execute({ id: '1', name: 'rejects', arguments: '{}' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('internal');
        expect(result.error.message).toContain('async boom');
      }
    });

    it('keeps counters claimed after timeout-after-start (not refunded)', async () => {
      vi.useFakeTimers();
      const registry = createRegistry({ timeoutMs: 10, maxCallsPerSession: 2 });
      registry.register({
        name: 'slow',
        description: 'takes longer than timeout',
        parameters: { type: 'object' },
        execute: async (_p, signal) => new Promise((resolve) => {
          const t = setTimeout(() => resolve(toolSuccess('done')), 1000);
          signal?.addEventListener('abort', () => clearTimeout(t));
        }),
      });
      registry.register({
        name: 'fast',
        description: 'fast',
        parameters: { type: 'object' },
        execute: async () => toolSuccess('ok'),
      });

      const first = registry.execute({ id: '1', name: 'slow', arguments: '{}' });
      await vi.advanceTimersByTimeAsync(50);
      const firstResult = await first;
      expect(firstResult.success).toBe(false); // timed out

      vi.useRealTimers();
      // Session limit is 2. The timeout consumed one slot and did NOT refund.
      // So we still have room for one more call.
      const second = await registry.execute({ id: '2', name: 'fast', arguments: '{}' });
      expect(second.success).toBe(true);
      // Third should be rate-limited (session cap = 2).
      const third = await registry.execute({ id: '3', name: 'fast', arguments: '{}' });
      expect(third.success).toBe(false);
      if (!third.success) expect(third.error.category).toBe('validation');
    });
  });
});
