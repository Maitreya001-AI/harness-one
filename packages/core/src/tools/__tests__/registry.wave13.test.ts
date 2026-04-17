/**
 * Wave-13 E-4 tests: per-turn cumulative argument byte cap in tool registry.
 */

import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry.js';
import { defineTool } from '../define-tool.js';
import { toolSuccess } from '../types.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';

function makePassthroughTool() {
  return defineTool<{ payload: string }>({
    name: 'passthrough',
    description: 'passthrough',
    parameters: {
      type: 'object',
      properties: { payload: { type: 'string' } },
      required: ['payload'],
    },
    capabilities: ['readonly'],
    execute: async (p) => toolSuccess(p.payload.length),
  });
}

describe('createRegistry Wave-13 E-4: maxTotalArgBytesPerTurn', () => {
  it('exposes maxTotalArgBytesPerTurn in getConfig() with default 10 MiB', () => {
    const reg = createRegistry();
    expect(reg.getConfig().maxTotalArgBytesPerTurn).toBe(10 * 1024 * 1024);
  });

  it('honors a custom maxTotalArgBytesPerTurn', () => {
    const reg = createRegistry({ maxTotalArgBytesPerTurn: 1024 });
    expect(reg.getConfig().maxTotalArgBytesPerTurn).toBe(1024);
  });

  it('throws ADAPTER_PAYLOAD_OVERSIZED when cumulative arg bytes exceed the cap', async () => {
    const reg = createRegistry({
      maxTotalArgBytesPerTurn: 200,
      timeoutMs: undefined,
    });
    reg.register(makePassthroughTool());

    // First call (~170 bytes) should succeed.
    const firstArgs = JSON.stringify({ payload: 'a'.repeat(150) });
    const r1 = await reg.execute({ id: '1', name: 'passthrough', arguments: firstArgs });
    expect(r1.success).toBe(true);

    // Second call pushes past 200 bytes.
    const secondArgs = JSON.stringify({ payload: 'b'.repeat(100) });
    await expect(
      reg.execute({ id: '2', name: 'passthrough', arguments: secondArgs }),
    ).rejects.toMatchObject({
      code: HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED,
    });
  });

  it('resets the per-turn byte counter on resetTurn()', async () => {
    const reg = createRegistry({
      maxTotalArgBytesPerTurn: 200,
      timeoutMs: undefined,
    });
    reg.register(makePassthroughTool());

    const big = JSON.stringify({ payload: 'a'.repeat(150) });
    await reg.execute({ id: '1', name: 'passthrough', arguments: big });

    // Without reset, a second call trips the cap.
    await expect(
      reg.execute({ id: '2', name: 'passthrough', arguments: big }),
    ).rejects.toThrow(HarnessError);

    reg.resetTurn();
    // After reset, the same call succeeds again.
    const r = await reg.execute({ id: '3', name: 'passthrough', arguments: big });
    expect(r.success).toBe(true);
  });

  it('resetSession() also clears the per-turn byte counter', async () => {
    const reg = createRegistry({
      maxTotalArgBytesPerTurn: 200,
      timeoutMs: undefined,
    });
    reg.register(makePassthroughTool());

    const big = JSON.stringify({ payload: 'a'.repeat(150) });
    await reg.execute({ id: '1', name: 'passthrough', arguments: big });

    reg.resetSession();
    const r = await reg.execute({ id: '2', name: 'passthrough', arguments: big });
    expect(r.success).toBe(true);
  });

  it('does not consume budget on pre-execution error (unknown tool)', async () => {
    const reg = createRegistry({
      maxTotalArgBytesPerTurn: 500,
      timeoutMs: undefined,
    });
    reg.register(makePassthroughTool());

    const big = JSON.stringify({ payload: 'a'.repeat(400) });
    // First: unknown tool — should NOT consume budget because the rate-limit
    // refund also needs to preserve the byte budget semantics. Current impl
    // consumes bytes only on admitted calls (incremented right before the
    // call runs), so this is implicit: pre-execution errors here are the
    // "not found" path which happens BEFORE byte-counter increment.
    const notFound = await reg.execute({ id: '1', name: 'missing', arguments: big });
    expect(notFound.success).toBe(false);

    // A subsequent successful call should still fit within the 500-byte cap.
    const r = await reg.execute({ id: '2', name: 'passthrough', arguments: big });
    expect(r.success).toBe(true);
  });
});
