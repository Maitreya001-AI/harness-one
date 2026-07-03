import { describe, it, expect } from 'vitest';
import { defineTool } from '../define-tool.js';
import { toolSuccess, toolError } from '../types.js';
import { createPermissiveRegistry } from '../registry.js';
import { HarnessError, HarnessErrorCode} from '../../core/errors.js';

describe('toolSuccess', () => {
  it('returns a success result', () => {
    const result = toolSuccess(42);
    expect(result).toEqual({ kind: 'success', success: true, data: 42 });
  });

  it('emits a discriminated union with kind === "success"', () => {
    const result = toolSuccess('ok');
    if (result.kind === 'success') {
      // TypeScript narrows to the success arm based on `kind`.
      expect(result.data).toBe('ok');
      expect(result.success).toBe(true);
    } else {
      throw new Error('expected kind=success');
    }
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
      kind: 'error',
      success: false,
      error: {
        message: 'not found',
        category: 'not_found',
        suggestedAction: 'Check the path',
        retryable: false,
      },
    });
  });

  it('emits a discriminated union with kind === "error"', () => {
    const result = toolError('nope', 'validation', 'try again');
    if (result.kind === 'error') {
      expect(result.error.category).toBe('validation');
      expect(result.success).toBe(false);
    } else {
      throw new Error('expected kind=error');
    }
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

  it('returns a well-formed tool definition', () => {
    expect(echoTool.name).toBe('echo');
    expect(echoTool.description).toBe('Echoes input');
    expect(typeof echoTool.execute).toBe('function');
  });

  it('executes successfully', async () => {
    const result = await echoTool.execute({ text: 'hello' });
    expect(result).toEqual({ kind: 'success', success: true, data: 'hello' });
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

  it('preserves responseFormat on the tool definition', () => {
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

  describe('Fix 8: Schema validation at definition time', () => {
    it('throws INVALID_TOOL_SCHEMA for an unsupported type', () => {
      expect(() => defineTool({
        name: 'bad',
        description: 'Bad tool',
        parameters: { type: 'invalid_type' as 'object' },
        execute: async () => toolSuccess(null),
      })).toThrow(HarnessError);

      try {
        defineTool({
          name: 'bad',
          description: 'Bad tool',
          parameters: { type: 'invalid_type' as 'object' },
          execute: async () => toolSuccess(null),
        });
      } catch (err) {
        expect((err as HarnessError).code).toBe(HarnessErrorCode.TOOL_INVALID_SCHEMA);
      }
    });

    it('throws INVALID_TOOL_SCHEMA when properties is not an object', () => {
      expect(() => defineTool({
        name: 'bad',
        description: 'Bad tool',
        parameters: { type: 'object', properties: 'not an object' as unknown as Record<string, never> },
        execute: async () => toolSuccess(null),
      })).toThrow(HarnessError);
    });

    it('throws INVALID_TOOL_SCHEMA when required is not an array', () => {
      expect(() => defineTool({
        name: 'bad',
        description: 'Bad tool',
        parameters: { type: 'object', required: 'not array' as unknown as string[] },
        execute: async () => toolSuccess(null),
      })).toThrow(HarnessError);
    });

    it('validates nested property schemas recursively', () => {
      expect(() => defineTool({
        name: 'bad',
        description: 'Bad tool',
        parameters: {
          type: 'object',
          properties: {
            nested: { type: 'invalid_nested' as 'string' },
          },
        },
        execute: async () => toolSuccess(null),
      })).toThrow(HarnessError);
    });

    it('validates items schema for array type', () => {
      expect(() => defineTool({
        name: 'bad',
        description: 'Bad tool',
        parameters: {
          type: 'array',
          items: { type: 'not_a_type' as 'string' },
        },
        execute: async () => toolSuccess(null),
      })).toThrow(HarnessError);
    });

    it('accepts valid schemas without throwing', () => {
      expect(() => defineTool({
        name: 'good',
        description: 'Good tool',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['name'],
        },
        execute: async () => toolSuccess(null),
      })).not.toThrow();
    });
  });

  describe('M1: thrown ToolResult-shaped objects are preserved, not wrapped', () => {
    it('collapses the obsolete {error, content} shape into an internal error', async () => {
      // Pre-kind/success-migration shape. Preserving it produced objects
      // that failed the registry's assertToolResult downstream — it must
      // now collapse into the generic internal-error wrap. Preservation
      // requires the current discriminated shape (see the
      // "structured-throw preservation" suite below).
      const toolResultLike = {
        error: { message: 'quota exceeded', category: 'internal' },
        content: 'Please try again later',
      };
      const tool = defineTool({
        name: 'quota-check',
        description: 'Throws an obsolete ToolResult-like object',
        parameters: { type: 'object' },
        execute: async () => {
          throw toolResultLike;
        },
      });

      const result = await tool.execute({});
      expect(result).not.toBe(toolResultLike);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('internal');
      }
    });

    it('does NOT preserve a thrown object with only error (no content)', async () => {
      const notToolResult = { error: 'just a string error' };
      const tool = defineTool({
        name: 'partial',
        description: 'Throws object with error but no content',
        parameters: { type: 'object' },
        execute: async () => {
          throw notToolResult;
        },
      });

      const result = await tool.execute({});
      // Missing 'content' field, so it should be wrapped as internal error
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('internal');
      }
    });

    it('does NOT preserve a thrown object with only content (no error)', async () => {
      const notToolResult = { content: 'just content' };
      const tool = defineTool({
        name: 'partial-content',
        description: 'Throws object with content but no error',
        parameters: { type: 'object' },
        execute: async () => {
          throw notToolResult;
        },
      });

      const result = await tool.execute({});
      // Missing 'error' field, so it should be wrapped as internal error
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.category).toBe('internal');
      }
    });

    it('preserves a thrown discriminated ToolResult even with extra fields', async () => {
      const richResult = {
        kind: 'error' as const,
        success: false as const,
        error: {
          message: 'rate limit',
          category: 'internal' as const,
          suggestedAction: 'Retry after the window resets',
          retryable: true,
        },
        retryAfter: 30,
      };
      const tool = defineTool({
        name: 'rate-limit',
        description: 'Throws a ToolResult with extra fields',
        parameters: { type: 'object' },
        execute: async () => {
          throw richResult;
        },
      });

      const result = await tool.execute({});
      // Valid kind/success discriminated shape — preserved verbatim,
      // extra fields and all.
      expect(result).toBe(richResult);
    });

    it('wraps a standard Error normally (not treated as ToolResult)', async () => {
      const tool = defineTool({
        name: 'standard-error',
        description: 'Throws a regular Error',
        parameters: { type: 'object' },
        execute: async () => {
          throw new Error('standard boom');
        },
      });

      const result = await tool.execute({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('standard boom');
        expect(result.error.category).toBe('internal');
      }
    });
  });

  describe('edge cases', () => {
    it('tool with responseFormat preserved on definition', () => {
      const tool = defineTool({
        name: 'detailed',
        description: 'Detailed tool',
        parameters: { type: 'object' },
        responseFormat: 'detailed',
        execute: async () => toolSuccess('data'),
      });
      expect(tool.responseFormat).toBe('detailed');
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

describe('defineTool structured-throw preservation', () => {
  it('preserves a thrown error-shaped ToolResult verbatim', async () => {
    const structured = toolError('quota exhausted', 'permission', 'Wait for the quota window to reset', false);
    const tool = defineTool({
      name: 'throws_structured',
      description: 'Throws a pre-built ToolResult',
      parameters: { type: 'object' },
      execute: async () => {
        throw structured;
      },
    });

    const result = await tool.execute({});
    expect(result).toBe(structured);
    if (!result.success) {
      expect(result.error.category).toBe('permission');
      expect(result.error.message).toBe('quota exhausted');
    }
  });

  it('preserves a thrown success-shaped ToolResult verbatim', async () => {
    const structured = toolSuccess({ recovered: true });
    const tool = defineTool({
      name: 'throws_success_shape',
      description: 'Throws a success ToolResult (odd but shape-valid)',
      parameters: { type: 'object' },
      execute: async () => {
        throw structured;
      },
    });

    const result = await tool.execute({});
    expect(result).toBe(structured);
  });

  it('collapses the legacy {error, content} throw shape into a generic internal error', async () => {
    // The pre-fix guard matched `'error' in err && 'content' in err` — a
    // shape ToolResult never had after the kind/success migration. Such
    // throws must now fall through to the generic internal-error wrap.
    const tool = defineTool({
      name: 'throws_legacy_shape',
      description: 'Throws the obsolete shape',
      parameters: { type: 'object' },
      execute: async () => {
         
        throw { error: 'boom', content: 'legacy' };
      },
    });

    const result = await tool.execute({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('internal');
    }
  });

  it('rejects malformed kind/success combinations (not preserved)', async () => {
    const tool = defineTool({
      name: 'throws_malformed',
      description: 'Throws a near-miss shape',
      parameters: { type: 'object' },
      execute: async () => {
        // kind says error but success says true — not a valid ToolResult.
         
        throw { kind: 'error', success: true, error: { message: 'x' } };
      },
    });

    const result = await tool.execute({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('internal');
    }
  });

  it('rejects error-shaped throws whose feedback lacks a string message', async () => {
    const tool = defineTool({
      name: 'throws_bad_feedback',
      description: 'Throws error shape with non-string message',
      parameters: { type: 'object' },
      execute: async () => {
         
        throw { kind: 'error', success: false, error: { message: 42 } };
      },
    });

    const result = await tool.execute({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.category).toBe('internal');
    }
  });
});

describe('defineTool schema-inference form (as const)', () => {
  it('defines and executes a tool whose params are inferred from an as-const schema', async () => {
    const tool = defineTool({
      name: 'search',
      description: 'Search issues',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' }, limit: { type: 'number' } },
        required: ['q'],
      } as const,
      capabilities: ['readonly'],
      // `params` is inferred as `{ q: string; limit?: number }` — no generic,
      // no cast. This test locks the runtime behaviour of overload 1.
      execute: async (params) =>
        toolSuccess(`${params.q}:${params.limit ?? 0}`),
    });

    expect(tool.name).toBe('search');
    const result = await tool.execute({ q: 'flaky', limit: 5 });
    expect(result).toEqual({ kind: 'success', success: true, data: 'flaky:5' });
  });

  it('registers an as-const-schema tool without any cast and executes it via the registry', async () => {
    const tool = defineTool({
      name: 'echo_const',
      description: 'Echo the message field',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      } as const,
      capabilities: ['readonly'],
      execute: async (params) => toolSuccess(params.message),
    });

    const registry = createPermissiveRegistry();
    // The whole point of the fix: no `tool as unknown as ...` needed here.
    registry.register(tool);

    const result = await registry.execute({
      id: 't1',
      name: 'echo_const',
      arguments: JSON.stringify({ message: 'hello' }),
    });
    expect(result).toEqual({ kind: 'success', success: true, data: 'hello' });
  });

  it('still supports the explicit-generic form (backward compatible)', async () => {
    const tool = defineTool<{ url: string }>({
      name: 'fetch_explicit',
      description: 'Fetch a URL',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      capabilities: ['readonly'],
      execute: async (params) => toolSuccess(params.url),
    });

    const result = await tool.execute({ url: 'https://example.com' });
    expect(result).toEqual({ kind: 'success', success: true, data: 'https://example.com' });
  });
});
