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

    it('passes context to permissions.check', async () => {
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
      expect(checkFn).toHaveBeenCalledWith('echo', undefined);
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
});
