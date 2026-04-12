/**
 * Tool middleware: cross-cutting concerns (retry, auth, timing) wrapped
 * around individual tool executions without modifying the tool itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRegistry } from '../registry.js';
import { toolSuccess, toolError, type ToolMiddleware, type ToolDefinition, type ToolResult } from '../types.js';

function makeTool(
  name: string,
  execute: ToolDefinition['execute'],
  middleware?: ToolMiddleware[],
): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: true } as ToolDefinition['parameters'],
    execute,
    ...(middleware && { middleware }),
  };
}

describe('ToolMiddleware', () => {
  it('single middleware wraps execute (onion order)', async () => {
    const trace: string[] = [];
    const mw: ToolMiddleware = async (_ctx, next) => {
      trace.push('before');
      const r = await next();
      trace.push('after');
      return r;
    };

    const tool = makeTool('t', async () => {
      trace.push('execute');
      return toolSuccess('ok');
    }, [mw]);

    const registry = createRegistry();
    registry.register(tool);

    const result = await registry.execute({ id: 'c1', name: 't', arguments: '{}' });
    expect(result).toEqual(toolSuccess('ok'));
    expect(trace).toEqual(['before', 'execute', 'after']);
  });

  it('multiple middleware nest onion-style (outer wraps inner)', async () => {
    const trace: string[] = [];
    const outer: ToolMiddleware = async (_c, next) => { trace.push('o-in'); const r = await next(); trace.push('o-out'); return r; };
    const inner: ToolMiddleware = async (_c, next) => { trace.push('i-in'); const r = await next(); trace.push('i-out'); return r; };
    const tool = makeTool('t', async () => { trace.push('exec'); return toolSuccess(1); }, [outer, inner]);

    const registry = createRegistry();
    registry.register(tool);
    await registry.execute({ id: 'c', name: 't', arguments: '{}' });
    expect(trace).toEqual(['o-in', 'i-in', 'exec', 'i-out', 'o-out']);
  });

  it('middleware can short-circuit without calling next()', async () => {
    const block: ToolMiddleware = async () => toolError('blocked', 'permission', 'nope');
    const execute = vi.fn(async () => toolSuccess('nope'));
    const tool = makeTool('t', execute, [block]);
    const registry = createRegistry();
    registry.register(tool);

    const result = await registry.execute({ id: 'c', name: 't', arguments: '{}' });
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('middleware receives toolName and params in context', async () => {
    let capturedToolName = '';
    let capturedParams: unknown = null;
    const mw: ToolMiddleware = async (ctx, next) => {
      capturedToolName = ctx.toolName;
      capturedParams = ctx.params;
      return next();
    };
    const tool = makeTool('calc', async () => toolSuccess(42), [mw]);
    const registry = createRegistry();
    registry.register(tool);
    await registry.execute({ id: 'c', name: 'calc', arguments: '{"a":1,"b":2}' });
    expect(capturedToolName).toBe('calc');
    expect(capturedParams).toEqual({ a: 1, b: 2 });
  });

  it('middleware can transform the returned result', async () => {
    const tag: ToolMiddleware = async (_c, next) => {
      const r = await next();
      if (r.success) return toolSuccess({ wrapped: r.data });
      return r;
    };
    const tool = makeTool('t', async () => toolSuccess(1), [tag]);
    const registry = createRegistry();
    registry.register(tool);
    const result = await registry.execute({ id: 'c', name: 't', arguments: '{}' }) as ToolResult;
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ wrapped: 1 });
  });
});
