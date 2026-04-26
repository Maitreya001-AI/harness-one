/**
 * Tests for the W3-E1 testing helpers:
 *   - createSlowMockAdapter (showcase 04)
 *   - spawnCrashable (showcase 03)
 *   - withTempCheckpointDir (HC-017)
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  createSlowMockAdapter,
  spawnCrashable,
  withTempCheckpointDir,
} from '../index.js';
import type { ChildProcess } from 'node:child_process';

const USAGE = { inputTokens: 1, outputTokens: 1 };

describe('createSlowMockAdapter', () => {
  it('delays chat() resolution by chatDelayMs', async () => {
    const adapter = createSlowMockAdapter({
      response: { message: { role: 'assistant', content: 'ok' }, usage: USAGE },
      chatDelayMs: 50,
    });
    const start = Date.now();
    await adapter.chat({ messages: [], model: 'm' });
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('chat() rejects with AbortError when signal fires during the wait', async () => {
    const adapter = createSlowMockAdapter({
      response: { message: { role: 'assistant', content: 'never' }, usage: USAGE },
      chatDelayMs: 1000,
    });
    const ac = new AbortController();
    const pending = adapter.chat({ messages: [], model: 'm', signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('chat() rejects immediately when signal already aborted', async () => {
    const adapter = createSlowMockAdapter({
      response: { message: { role: 'assistant', content: 'never' }, usage: USAGE },
      chatDelayMs: 1000,
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      adapter.chat({ messages: [], model: 'm', signal: ac.signal }),
    ).rejects.toThrow(/abort/i);
  });

  it('respectAbort=false ignores the signal', async () => {
    const adapter = createSlowMockAdapter({
      response: { message: { role: 'assistant', content: 'eventually' }, usage: USAGE },
      chatDelayMs: 30,
      respectAbort: false,
    });
    const ac = new AbortController();
    ac.abort();
    // Should NOT throw; the delay completes and chat() returns.
    const r = await adapter.chat({ messages: [], model: 'm', signal: ac.signal });
    expect(r.message.content).toBe('eventually');
  });

  it('stream() inserts streamChunkDelayMs between chunks', async () => {
    const adapter = createSlowMockAdapter({
      response: { message: { role: 'assistant', content: 'hi' }, usage: USAGE },
      chunks: [
        { type: 'text_delta', text: 'h' },
        { type: 'text_delta', text: 'i' },
        { type: 'done', usage: USAGE },
      ],
      streamChunkDelayMs: 20,
    });
    const start = Date.now();
    for await (const _ of adapter.stream!({ messages: [], model: 'm' })) {
      void _;
    }
    // Three chunks × 20ms each = ~60ms minimum.
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });

  it('records calls on both chat() and stream()', async () => {
    const adapter = createSlowMockAdapter({
      response: { message: { role: 'assistant', content: 'x' }, usage: USAGE },
    });
    await adapter.chat({ messages: [], model: 'm' });
    for await (const _ of adapter.stream!({ messages: [], model: 'm2' })) {
      void _;
    }
    expect(adapter.calls).toHaveLength(2);
  });
});

describe('spawnCrashable', () => {
  function fakeChild(opts: { exitDelay?: number; emit: { code?: number | null; signal?: NodeJS.Signals | null }; killHandler?: (sig: NodeJS.Signals) => void }): ChildProcess {
    const ee = new EventEmitter() as ChildProcess & EventEmitter;
    (ee as ChildProcess & { kill: (sig: NodeJS.Signals) => boolean }).kill = (sig: NodeJS.Signals) => {
      opts.killHandler?.(sig);
      return true;
    };
    setTimeout(() => {
      ee.emit('exit', opts.emit.code ?? null, opts.emit.signal ?? null);
    }, opts.exitDelay ?? 5);
    return ee;
  }

  it('reports clean exit when child exits with code 0', async () => {
    const outcome = await spawnCrashable({
      entry: 'node',
      args: ['-e', 'process.exit(0)'],
      spawner: () => fakeChild({ emit: { code: 0 } }),
    });
    expect(outcome.outcome).toBe('clean');
    if (outcome.outcome === 'clean') expect(outcome.code).toBe(0);
  });

  it('reports killed when child exits with signal=SIGKILL', async () => {
    const outcome = await spawnCrashable({
      entry: 'node',
      args: [],
      killAt: 5,
      spawner: () => fakeChild({ emit: { code: null, signal: 'SIGKILL' } }),
    });
    expect(outcome.outcome).toBe('killed');
    if (outcome.outcome === 'killed') expect(outcome.signal).toBe('SIGKILL');
  });

  it('reports killed when child exits with code 137 (laundered SIGKILL)', async () => {
    // This is the canonical bug from showcase 03: pnpm/tsx wrappers
    // translate SIGKILL into exit code 137 (128 + 9). spawnCrashable
    // recognises this and still reports `outcome: 'killed'`.
    const outcome = await spawnCrashable({
      entry: 'pnpm',
      args: ['exec', 'node', '-e', '...'],
      killAt: 5,
      spawner: () => fakeChild({ emit: { code: 137, signal: null } }),
    });
    expect(outcome.outcome).toBe('killed');
    if (outcome.outcome === 'killed') {
      expect(outcome.code).toBe(137);
      expect(outcome.signal).toBeNull();
    }
  });

  it('reports errored on non-zero exit codes other than 137', async () => {
    const outcome = await spawnCrashable({
      entry: 'node',
      args: [],
      spawner: () => fakeChild({ emit: { code: 1 } }),
    });
    expect(outcome.outcome).toBe('errored');
    if (outcome.outcome === 'errored') expect(outcome.code).toBe(1);
  });

  it('reports killed for non-SIGKILL signals when no clean exit', async () => {
    const outcome = await spawnCrashable({
      entry: 'node',
      args: [],
      spawner: () => fakeChild({ emit: { code: null, signal: 'SIGTERM' } }),
    });
    expect(outcome.outcome).toBe('killed');
    if (outcome.outcome === 'killed') expect(outcome.signal).toBe('SIGTERM');
  });

  it('rejects on spawner-error event', async () => {
    const ee = new EventEmitter() as ChildProcess & EventEmitter;
    (ee as ChildProcess & { kill: (sig: NodeJS.Signals) => boolean }).kill = () => true;
    setTimeout(() => ee.emit('error', new Error('ENOENT')), 5);
    await expect(
      spawnCrashable({ entry: 'doesnotexist', args: [], spawner: () => ee }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('respects killAt — child gets SIGKILL after the specified delay', async () => {
    let received: NodeJS.Signals | undefined;
    const handler = (sig: NodeJS.Signals): void => {
      received = sig;
    };
    await spawnCrashable({
      entry: 'node',
      args: [],
      killAt: 10,
      spawner: () =>
        fakeChild({
          exitDelay: 50,
          emit: { code: null, signal: 'SIGKILL' },
          killHandler: handler,
        }),
    });
    expect(received).toBe('SIGKILL');
  });
});

describe('withTempCheckpointDir', () => {
  it('creates a writable directory and cleans up afterwards', async () => {
    let captured: string | undefined;
    await withTempCheckpointDir(async (dir) => {
      captured = dir;
      // Sanity: write a file inside.
      await fs.writeFile(`${dir}/hello.txt`, 'x');
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });
    // After return, the dir is gone.
    expect(captured).toBeDefined();
    await expect(fs.stat(captured!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the dir when keep:true is set', async () => {
    let captured: string | undefined;
    await withTempCheckpointDir({ keep: true }, async (dir) => {
      captured = dir;
      await fs.writeFile(`${dir}/hello.txt`, 'x');
    });
    expect(captured).toBeDefined();
    const stat = await fs.stat(captured!);
    expect(stat.isDirectory()).toBe(true);
    // Manual cleanup so we don't litter.
    await fs.rm(captured!, { recursive: true, force: true });
  });

  it('cleans up even when the callback throws', async () => {
    let captured: string | undefined;
    const err = new Error('boom');
    await expect(
      withTempCheckpointDir(async (dir) => {
        captured = dir;
        throw err;
      }),
    ).rejects.toBe(err);
    expect(captured).toBeDefined();
    await expect(fs.stat(captured!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns the callback return value', async () => {
    const result = await withTempCheckpointDir(async () => 42);
    expect(result).toBe(42);
  });

  it('honours custom prefix', async () => {
    let captured: string | undefined;
    await withTempCheckpointDir({ prefix: 'mytest-' }, async (dir) => {
      captured = dir;
    });
    expect(captured).toMatch(/mytest-/);
  });

  it('throws when callback is missing', async () => {
    await expect(
      // @ts-expect-error — runtime guard
      withTempCheckpointDir({}),
    ).rejects.toThrow(/callback/i);
  });
});
