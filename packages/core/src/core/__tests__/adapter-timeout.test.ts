/**
 * Unit tests for withAdapterTimeout — the extracted timeout/abort-chaining
 * helper. Exercises the behaviour that previously lived inline in
 * `adapter-caller.ts`, now as a focused contract:
 *
 *  - successful resolution (no timeout triggered)
 *  - external abort forwards into the adapter's signal
 *  - already-aborted external signal aborts the internal controller upfront
 *  - timeout rejects with HarnessError(CORE_TIMEOUT)
 *  - orphaned adapter promise rejection after timeout is caught + logged
 *  - tools are forwarded when provided, absent when not
 */

import { describe, it, expect, vi } from 'vitest';
import { withAdapterTimeout } from '../adapter-timeout.js';
import { HarnessError, HarnessErrorCode } from '../errors.js';
import type { AgentAdapter, ChatResponse, Message, ToolSchema } from '../types.js';

const USAGE = { inputTokens: 1, outputTokens: 1 };

function makeAdapter(impl: Partial<AgentAdapter>): AgentAdapter {
  return {
    async chat(): Promise<ChatResponse> {
      throw new Error('chat not mocked');
    },
    ...impl,
  };
}

describe('withAdapterTimeout', () => {
  it('resolves with message+usage when the adapter responds before the timeout', async () => {
    const controller = new AbortController();
    const chatSpy = vi.fn().mockResolvedValue({
      message: { role: 'assistant', content: 'ok' },
      usage: USAGE,
    } satisfies ChatResponse);
    const adapter = makeAdapter({ chat: chatSpy });

    const result = await withAdapterTimeout({
      adapter,
      messages: [{ role: 'user', content: 'hi' }] as Message[],
      externalSignal: controller.signal,
      timeoutMs: 1_000,
    });

    expect(result.message.content).toBe('ok');
    expect(result.usage).toEqual(USAGE);
  });

  it('throws HarnessError(CORE_TIMEOUT) when the adapter hangs past timeoutMs', async () => {
    const controller = new AbortController();
    const adapter = makeAdapter({
      chat: vi.fn().mockImplementation(() => new Promise(() => {
        /* never resolves */
      })),
    });

    await expect(
      withAdapterTimeout({
        adapter,
        messages: [{ role: 'user', content: 'hi' }] as Message[],
        externalSignal: controller.signal,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: HarnessErrorCode.CORE_TIMEOUT,
    });
  });

  it('forwards an external abort into the adapter signal', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const adapter = makeAdapter({
      chat: vi.fn().mockImplementation((params: { signal?: AbortSignal }) => {
        capturedSignal = params.signal;
        return new Promise((_, reject) => {
          params.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          }, { once: true });
        });
      }),
    });

    const p = withAdapterTimeout({
      adapter,
      messages: [{ role: 'user', content: 'hi' }] as Message[],
      externalSignal: controller.signal,
      timeoutMs: 5_000,
    });
    // Abort asynchronously after chat has been invoked.
    queueMicrotask(() => controller.abort());
    await expect(p).rejects.toBeInstanceOf(Error);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('aborts the internal signal immediately when external signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let capturedAborted = false;
    const adapter = makeAdapter({
      chat: vi.fn().mockImplementation((params: { signal?: AbortSignal }) => {
        capturedAborted = params.signal?.aborted ?? false;
        return Promise.reject(new Error('aborted upfront'));
      }),
    });

    await expect(
      withAdapterTimeout({
        adapter,
        messages: [] as Message[],
        externalSignal: controller.signal,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow();
    expect(capturedAborted).toBe(true);
  });

  it('logs an orphan-adapter debug event when the adapter rejects after timeout', async () => {
    const controller = new AbortController();
    const debug = vi.fn();
    let rejectChat: (err: unknown) => void = () => {};
    const adapter = makeAdapter({
      name: 'slow-provider',
      chat: vi.fn().mockImplementation(() =>
        new Promise((_, reject) => {
          rejectChat = reject;
        }),
      ),
    });

    const p = withAdapterTimeout({
      adapter,
      messages: [] as Message[],
      externalSignal: controller.signal,
      timeoutMs: 10,
      logger: { debug },
    });
    await expect(p).rejects.toBeInstanceOf(HarnessError);

    // Simulate the adapter's late rejection (after the timeout resolved).
    rejectChat(new Error('too-late upstream'));
    // Drain the microtask queue so the .catch() fires.
    await new Promise((r) => setImmediate(r));

    expect(debug).toHaveBeenCalledWith(
      'adapter orphan after timeout',
      expect.objectContaining({
        adapter: 'slow-provider',
        timeoutMs: 10,
        error: expect.stringContaining('too-late'),
      }),
    );
  });

  it('increments harness.adapter.orphan_after_timeout when metrics is supplied', async () => {
    const controller = new AbortController();
    let rejectChat: (err: unknown) => void = () => {};
    const adapter = makeAdapter({
      name: 'slow-provider-2',
      chat: vi.fn().mockImplementation(() =>
        new Promise((_, reject) => {
          rejectChat = reject;
        }),
      ),
    });
    const inc = vi.fn();
    const counter = vi.fn(() => ({ inc }));
    const metrics = { counter };

    const p = withAdapterTimeout({
      adapter,
      messages: [] as Message[],
      externalSignal: controller.signal,
      timeoutMs: 10,
      metrics,
    });
    await expect(p).rejects.toBeInstanceOf(HarnessError);
    rejectChat(new Error('late rejection'));
    await new Promise((r) => setImmediate(r));

    expect(counter).toHaveBeenCalledWith('harness.adapter.orphan_after_timeout');
    expect(inc).toHaveBeenCalledWith(1, { adapter: 'slow-provider-2' });
  });

  it('tolerates a metrics backend that throws', async () => {
    const controller = new AbortController();
    let rejectChat: (err: unknown) => void = () => {};
    const adapter = makeAdapter({
      name: 'slow-provider-3',
      chat: vi.fn().mockImplementation(() =>
        new Promise((_, reject) => {
          rejectChat = reject;
        }),
      ),
    });
    const metrics = {
      counter: vi.fn(() => {
        throw new Error('broken metrics backend');
      }),
    };

    const p = withAdapterTimeout({
      adapter,
      messages: [] as Message[],
      externalSignal: controller.signal,
      timeoutMs: 10,
      metrics,
    });
    await expect(p).rejects.toBeInstanceOf(HarnessError);
    // No extra handler error should surface.
    rejectChat(new Error('late rejection'));
    await new Promise((r) => setImmediate(r));
  });

  it('forwards tools when provided and omits the key when not', async () => {
    const controller = new AbortController();
    const chatSpy = vi.fn().mockResolvedValue({
      message: { role: 'assistant', content: 'ok' },
      usage: USAGE,
    } satisfies ChatResponse);
    const adapter = makeAdapter({ chat: chatSpy });

    const tool: ToolSchema = {
      name: 'get_time',
      description: 'Return current time',
      parameters: { type: 'object', properties: {} },
    };
    await withAdapterTimeout({
      adapter,
      messages: [] as Message[],
      tools: [tool],
      externalSignal: controller.signal,
      timeoutMs: 1_000,
    });
    expect(chatSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ tools: [tool] }),
    );

    chatSpy.mockClear();
    await withAdapterTimeout({
      adapter,
      messages: [] as Message[],
      externalSignal: controller.signal,
      timeoutMs: 1_000,
    });
    expect(chatSpy.mock.calls[0]?.[0]).not.toHaveProperty('tools');
  });
});
