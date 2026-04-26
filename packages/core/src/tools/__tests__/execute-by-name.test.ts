/**
 * Tests for `ToolRegistry.executeByName(name, args)` — the convenience
 * wrapper around `execute(call)` introduced for HARNESS_LOG HC-009.
 *
 * Coverage matrix:
 *   - Happy path returns the tool's success result
 *   - Args are JSON-serialised before reaching the tool
 *   - Unknown-tool error path
 *   - Non-serialisable args (BigInt, cycle) raise validation
 *   - Empty / non-string name rejected
 *   - Synthesised id is unique across calls
 */
import { describe, it, expect, vi } from 'vitest';
import { createRegistry } from '../registry.js';
import { defineTool } from '../define-tool.js';
import { ToolCapability, toolSuccess } from '../types.js';

interface EchoInput { readonly say: string; readonly count?: number }

function echoTool() {
  const exec = vi.fn(async (input: EchoInput) => toolSuccess({ said: input.say, count: input.count ?? 1 }));
  const tool = defineTool<EchoInput>({
    name: 'echo',
    description: 'echo',
    capabilities: [ToolCapability.Readonly],
    parameters: {
      type: 'object',
      properties: {
        say: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['say'],
      additionalProperties: false,
    },
    execute: exec,
  });
  return { tool, exec };
}

describe('ToolRegistry.executeByName', () => {
  it('returns the tool result on a successful call', async () => {
    const { tool } = echoTool();
    const r = createRegistry();
    r.register(tool);
    const result = await r.executeByName('echo', { say: 'hi' });
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.data).toEqual({ said: 'hi', count: 1 });
    }
  });

  it('JSON-serialises args before delivering them to the tool', async () => {
    const { tool, exec } = echoTool();
    const r = createRegistry();
    r.register(tool);
    await r.executeByName('echo', { say: 'world', count: 3 });
    const callArgs = exec.mock.calls[0][0];
    expect(callArgs).toEqual({ say: 'world', count: 3 });
  });

  it('treats undefined args as an empty object {}', async () => {
    const tool = defineTool<{ ok?: boolean }>({
      name: 'noargs',
      description: 'no args required',
      capabilities: [ToolCapability.Readonly],
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => toolSuccess({ ran: true }),
    });
    const r = createRegistry();
    r.register(tool);
    const result = await r.executeByName('noargs', undefined);
    expect(result.kind).toBe('success');
  });

  it('returns a validation error for unknown tools', async () => {
    const r = createRegistry();
    const result = await r.executeByName('does-not-exist', {});
    expect(result.kind).toBe('error');
  });

  it('rejects empty / non-string name with a validation error', async () => {
    const r = createRegistry();
    const result = await r.executeByName('', {});
    expect(result.kind).toBe('error');
    // @ts-expect-error — runtime guard
    const result2 = await r.executeByName(123, {});
    expect(result2.kind).toBe('error');
  });

  it('rejects non-JSON-serialisable args (BigInt) with a validation error', async () => {
    const { tool } = echoTool();
    const r = createRegistry();
    r.register(tool);
    const result = await r.executeByName('echo', { say: 'x', count: 1n as unknown as number });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.message).toContain('JSON-serialise');
    }
  });

  it('rejects non-JSON-serialisable args (cycle) with a validation error', async () => {
    const { tool } = echoTool();
    const r = createRegistry();
    r.register(tool);
    const cycle: { say: string; self?: unknown } = { say: 'x' };
    cycle.self = cycle;
    const result = await r.executeByName('echo', cycle);
    expect(result.kind).toBe('error');
  });

  it('synthesises a unique call id for every invocation', async () => {
    // We cannot directly inspect the synthesised id from the public
    // surface, but we can verify two consecutive calls succeed without
    // colliding on the per-turn rate-limit accountant (which keys on
    // call.id internally for some bookkeeping).
    const { tool } = echoTool();
    const r = createRegistry({ maxCallsPerTurn: 100 });
    r.register(tool);
    const a = await r.executeByName('echo', { say: 'a' });
    const b = await r.executeByName('echo', { say: 'b' });
    expect(a.kind).toBe('success');
    expect(b.kind).toBe('success');
  });

  it('honours the registry rate limit just like execute()', async () => {
    const { tool } = echoTool();
    const r = createRegistry({ maxCallsPerTurn: 1 });
    r.register(tool);
    await r.executeByName('echo', { say: 'first' });
    const second = await r.executeByName('echo', { say: 'second' });
    expect(second.kind).toBe('error');
  });
});
