import { describe, it, expect, vi } from 'vitest';
import type { ToolCallRequest } from '../types.js';
import { createSequentialStrategy, createParallelStrategy } from '../execution-strategies.js';

function makeCall(id: string, name = 'tool'): ToolCallRequest {
  return { id, name, arguments: '{}' };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('createSequentialStrategy', () => {
  it('executes 3 calls in order and returns matching results', async () => {
    const strategy = createSequentialStrategy();
    const calls = [makeCall('1', 'a'), makeCall('2', 'b'), makeCall('3', 'c')];
    const order: string[] = [];

    const handler = async (call: ToolCallRequest) => {
      order.push(call.id);
      return `result-${call.id}`;
    };

    const results = await strategy.execute(calls, handler);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ toolCallId: '1', result: 'result-1' });
    expect(results[1]).toEqual({ toolCallId: '2', result: 'result-2' });
    expect(results[2]).toEqual({ toolCallId: '3', result: 'result-3' });
    expect(order).toEqual(['1', '2', '3']);
  });

  it('catches errors and returns error result', async () => {
    const strategy = createSequentialStrategy();
    const calls = [makeCall('1')];
    const handler = async () => { throw new Error('boom'); };

    const results = await strategy.execute(calls, handler);

    expect(results[0]).toMatchObject({ toolCallId: '1', result: { error: 'boom' } });
  });
});

describe('createParallelStrategy', () => {
  it('executes 3 calls in parallel and returns results', async () => {
    const strategy = createParallelStrategy();
    const calls = [makeCall('1'), makeCall('2'), makeCall('3')];
    const start = Date.now();

    const handler = async (call: ToolCallRequest) => {
      await delay(50);
      return `result-${call.id}`;
    };

    const results = await strategy.execute(calls, handler);
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ toolCallId: '1', result: 'result-1' });
    expect(results[1]).toEqual({ toolCallId: '2', result: 'result-2' });
    expect(results[2]).toEqual({ toolCallId: '3', result: 'result-3' });
    // All 3 run concurrently with default maxConcurrency=5, so total < 100ms
    expect(elapsed).toBeLessThan(100);
  });

  it('respects concurrency cap', async () => {
    const strategy = createParallelStrategy({ maxConcurrency: 2 });
    const calls = Array.from({ length: 10 }, (_, i) => makeCall(`${i}`));
    let running = 0;
    let maxRunning = 0;

    const handler = async (call: ToolCallRequest) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await delay(20);
      running--;
      return call.id;
    };

    await strategy.execute(calls, handler);

    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(maxRunning).toBeGreaterThanOrEqual(1);
  });

  it('runs sequential tools after parallel group', async () => {
    const strategy = createParallelStrategy();
    const calls = [makeCall('p1', 'fast'), makeCall('p2', 'fast'), makeCall('s1', 'slow')];
    const order: string[] = [];

    const handler = async (call: ToolCallRequest) => {
      order.push(call.id);
      await delay(10);
      return call.id;
    };

    const getMeta = (name: string) => (name === 'slow' ? { sequential: true } : undefined);

    const results = await strategy.execute(calls, handler, { getToolMeta: getMeta });

    // Sequential tool 's1' should come after both parallel tools
    expect(order.indexOf('s1')).toBeGreaterThan(order.indexOf('p1'));
    expect(order.indexOf('s1')).toBeGreaterThan(order.indexOf('p2'));
    // Results still in original call order
    expect(results[0].toolCallId).toBe('p1');
    expect(results[1].toolCallId).toBe('p2');
    expect(results[2].toolCallId).toBe('s1');
  });

  it('isolates errors — failed tool does not block others', async () => {
    const strategy = createParallelStrategy();
    const calls = [makeCall('1', 'ok'), makeCall('2', 'fail'), makeCall('3', 'ok')];

    const handler = async (call: ToolCallRequest) => {
      if (call.name === 'fail') throw new Error('kaboom');
      return `ok-${call.id}`;
    };

    const results = await strategy.execute(calls, handler);

    expect(results[0]).toEqual({ toolCallId: '1', result: 'ok-1' });
    expect(results[1]).toMatchObject({ toolCallId: '2', result: { error: 'kaboom' } });
    expect(results[2]).toEqual({ toolCallId: '3', result: 'ok-3' });
  });

  it('returns results in original call order regardless of completion order', async () => {
    const strategy = createParallelStrategy();
    // Different delays: call 0 slowest, call 2 fastest
    const calls = [makeCall('slow', 'a'), makeCall('mid', 'b'), makeCall('fast', 'c')];
    const delays: Record<string, number> = { slow: 60, mid: 30, fast: 10 };

    const handler = async (call: ToolCallRequest) => {
      await delay(delays[call.id]);
      return call.id;
    };

    const results = await strategy.execute(calls, handler);

    expect(results[0].toolCallId).toBe('slow');
    expect(results[1].toolCallId).toBe('mid');
    expect(results[2].toolCallId).toBe('fast');
    expect(results[0].result).toBe('slow');
    expect(results[1].result).toBe('mid');
    expect(results[2].result).toBe('fast');
  });

  it('handles empty calls array', async () => {
    const strategy = createParallelStrategy();
    const handler = vi.fn();

    const results = await strategy.execute([], handler);

    expect(results).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('handles a single call without error', async () => {
    const strategy = createParallelStrategy();
    const calls = [makeCall('only')];

    const handler = async (call: ToolCallRequest) => `done-${call.id}`;

    const results = await strategy.execute(calls, handler);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ toolCallId: 'only', result: 'done-only' });
  });
});
