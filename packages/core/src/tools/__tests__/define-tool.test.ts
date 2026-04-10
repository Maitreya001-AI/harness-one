import { describe, it, expect } from 'vitest';
import { defineTool } from '../define-tool.js';
import { toolSuccess, toolError } from '../types.js';

describe('toolSuccess', () => {
  it('returns a success result', () => {
    const result = toolSuccess(42);
    expect(result).toEqual({ success: true, data: 42 });
  });

  it('works with complex data', () => {
    const data = { items: [1, 2, 3] };
    const result = toolSuccess(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(data);
    }
  });
});

describe('toolError', () => {
  it('returns a failure result with feedback', () => {
    const result = toolError('not found', 'not_found', 'Check the path');
    expect(result).toEqual({
      success: false,
      error: {
        message: 'not found',
        category: 'not_found',
        suggestedAction: 'Check the path',
        retryable: false,
      },
    });
  });

  it('supports retryable flag', () => {
    const result = toolError('timeout', 'timeout', 'Retry', true);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.retryable).toBe(true);
    }
  });

  it('defaults retryable to false', () => {
    const result = toolError('err', 'internal', 'fix it');
    if (!result.success) {
      expect(result.error.retryable).toBe(false);
    }
  });
});

describe('defineTool', () => {
  const echoTool = defineTool<{ text: string }>({
    name: 'echo',
    description: 'Echoes input',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute: async (params) => toolSuccess(params.text),
  });

  it('creates a tool with correct properties', () => {
    expect(echoTool.name).toBe('echo');
    expect(echoTool.description).toBe('Echoes input');
    expect(echoTool.parameters.type).toBe('object');
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(echoTool)).toBe(true);
  });

  it('executes successfully', async () => {
    const result = await echoTool.execute({ text: 'hello' });
    expect(result).toEqual({ success: true, data: 'hello' });
  });

  it('catches thrown errors and returns toolError', async () => {
    const failTool = defineTool({
      name: 'fail',
      description: 'Always fails',
      parameters: { type: 'object' },
      execute: async () => {
        throw new Error('boom');
      },
    });

    const result = await failTool.execute({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('boom');
      expect(result.error.category).toBe('internal');
    }
  });

  it('catches non-Error throws', async () => {
    const failTool = defineTool({
      name: 'fail',
      description: 'Throws string',
      parameters: { type: 'object' },
      execute: async () => {
        throw 'string error';
      },
    });

    const result = await failTool.execute({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('string error');
    }
  });

  it('passes abort signal to execute', async () => {
    let receivedSignal: AbortSignal | undefined;
    const tool = defineTool({
      name: 'sig',
      description: 'Captures signal',
      parameters: { type: 'object' },
      execute: async (_params, signal) => {
        receivedSignal = signal;
        return toolSuccess(null);
      },
    });

    const controller = new AbortController();
    await tool.execute({}, controller.signal);
    expect(receivedSignal).toBe(controller.signal);
  });

  it('propagates toolError results from execute', async () => {
    const tool = defineTool({
      name: 'denied',
      description: 'Permission denied',
      parameters: { type: 'object' },
      execute: async () => toolError('denied', 'permission', 'Get access'),
    });

    const result = await tool.execute({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('permission');
    }
  });

  it('preserves responseFormat on the frozen tool definition', () => {
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

    expect(tool.responseFormat).toBe('concise');
    expect(Object.isFrozen(tool)).toBe(true);
  });

  it('defaults responseFormat to undefined when not provided', () => {
    const tool = defineTool({
      name: 'basic',
      description: 'Basic tool',
      parameters: { type: 'object' },
      execute: async () => toolSuccess(null),
    });

    expect(tool.responseFormat).toBeUndefined();
  });

  describe('edge cases', () => {
    it('tool with responseFormat preserved on frozen definition', () => {
      const tool = defineTool({
        name: 'detailed',
        description: 'Detailed tool',
        parameters: { type: 'object' },
        responseFormat: 'detailed',
        execute: async () => toolSuccess('data'),
      });
      expect(tool.responseFormat).toBe('detailed');
      expect(Object.isFrozen(tool)).toBe(true);
      // Verify it cannot be changed
      expect(() => {
        (tool as unknown as { responseFormat: string }).responseFormat = 'concise';
      }).toThrow();
    });

    it('tool handler returning complex nested object', async () => {
      const tool = defineTool<Record<string, never>>({
        name: 'complex',
        description: 'Returns complex data',
        parameters: { type: 'object' },
        execute: async () => toolSuccess({
          users: [
            { name: 'Alice', roles: ['admin', 'user'], profile: { age: 30 } },
            { name: 'Bob', roles: ['user'], profile: { age: 25 } },
          ],
          meta: { total: 2, page: 1 },
        }),
      });

      const result = await tool.execute({});
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { users: { name: string; roles: string[]; profile: { age: number } }[]; meta: { total: number; page: number } };
        expect(data).toHaveProperty('users');
        expect(data.users).toHaveLength(2);
        expect(data.users[0].roles).toContain('admin');
        expect(data.meta.total).toBe(2);
      }
    });

    it('tool handler with async error (rejected promise)', async () => {
      const tool = defineTool({
        name: 'async_fail',
        description: 'Fails asynchronously',
        parameters: { type: 'object' },
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          throw new Error('async failure');
        },
      });

      const result = await tool.execute({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('async failure');
        expect(result.error.category).toBe('internal');
      }
    });
  });
});
