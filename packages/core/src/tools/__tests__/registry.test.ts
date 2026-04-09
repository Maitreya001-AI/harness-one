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
      expect(result).toEqual({ success: true, data: 'hello' });
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
});
