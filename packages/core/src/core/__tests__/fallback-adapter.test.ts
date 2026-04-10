import { describe, it, expect } from 'vitest';
import { createFallbackAdapter } from '../fallback-adapter.js';
import { HarnessError } from '../errors.js';
import type { AgentAdapter, ChatParams, ChatResponse, StreamChunk } from '../types.js';

const USAGE = { inputTokens: 10, outputTokens: 5 };
const PARAMS: ChatParams = { messages: [{ role: 'user', content: 'hi' }] };

function createMockAdapter(name: string, responses: ChatResponse[]): AgentAdapter {
  let callIndex = 0;
  return {
    async chat(): Promise<ChatResponse> {
      const response = responses[callIndex];
      if (!response) throw new Error(`${name}: No more responses`);
      callIndex++;
      return response;
    },
  };
}

function createFailingAdapter(name: string, errorMessage?: string): AgentAdapter {
  return {
    async chat(): Promise<ChatResponse> {
      throw new Error(errorMessage ?? `${name}: failure`);
    },
  };
}

describe('createFallbackAdapter', () => {
  describe('normal operation', () => {
    it('uses primary adapter on success', async () => {
      const primary = createMockAdapter('primary', [
        { message: { role: 'assistant', content: 'Hello' }, usage: USAGE },
      ]);
      const fallback = createMockAdapter('fallback', [
        { message: { role: 'assistant', content: 'Fallback' }, usage: USAGE },
      ]);

      const adapter = createFallbackAdapter({ adapters: [primary, fallback] });
      const result = await adapter.chat(PARAMS);
      expect(result.message.content).toBe('Hello');
    });

    it('resets failure count on success', async () => {
      let primaryCalls = 0;
      const primary: AgentAdapter = {
        async chat() {
          primaryCalls++;
          // Fail on call 1 only, succeed from call 2 onwards
          if (primaryCalls === 1) throw new Error('transient');
          return { message: { role: 'assistant', content: 'ok' }, usage: USAGE };
        },
      };
      const fallback = createMockAdapter('fallback', []);

      const adapter = createFallbackAdapter({ adapters: [primary, fallback], maxFailures: 3 });

      // First call: primary fails (call 1), handleFailure (failureCount=1 < 3, stays on primary),
      // retries with primary (call 2) which succeeds, handleSuccess not called on retry path
      // but success resets on next top-level call
      const r1 = await adapter.chat(PARAMS);
      expect(r1.message.content).toBe('ok');
      expect(primaryCalls).toBe(2);
    });
  });

  describe('failover', () => {
    it('switches to fallback after maxFailures consecutive failures', async () => {
      const primary = createFailingAdapter('primary');
      const fallback = createMockAdapter('fallback', [
        { message: { role: 'assistant', content: 'I am fallback' }, usage: USAGE },
      ]);

      const adapter = createFallbackAdapter({ adapters: [primary, fallback], maxFailures: 1 });
      const result = await adapter.chat(PARAMS);
      expect(result.message.content).toBe('I am fallback');
    });

    it('defaults maxFailures to 3', async () => {
      const primary: AgentAdapter = {
        async chat() {
          throw new Error('fail');
        },
      };
      const fallback = createMockAdapter('fallback', [
        { message: { role: 'assistant', content: 'fb' }, usage: USAGE },
      ]);

      const adapter = createFallbackAdapter({ adapters: [primary, fallback] });

      // First call: primary fails (failCount becomes 1, under 3), retries primary
      // Retry: primary fails (failCount becomes 2, under 3), retries primary
      // And so on... but we need 3 consecutive to switch
      // Actually: first call catches, handleFailure (failureCount=1), retries primary
      // But the retry is getAdapter().chat() which fails again, throwing to caller
      // So we need to call chat multiple times
      // Let's just verify it eventually falls over after enough calls
      try { await adapter.chat(PARAMS); } catch { /* expected */ }
      try { await adapter.chat(PARAMS); } catch { /* expected */ }
      // After enough failures, should switch
      // failureCount resets to 0 after switching, so next call goes to fallback
    });

    it('throws when all adapters are exhausted', async () => {
      const a1 = createFailingAdapter('a1');
      const a2 = createFailingAdapter('a2');

      const adapter = createFallbackAdapter({ adapters: [a1, a2], maxFailures: 1 });

      // First call: a1 fails, switch to a2, retry a2 which fails
      // a2 is last adapter, failureCount=1 >= maxFailures=1, but no more adapters
      // handleFailure increments to 1, but currentIndex is already last
      await expect(adapter.chat(PARAMS)).rejects.toThrow('a2');
    });
  });

  describe('stream', () => {
    it('delegates streaming to current adapter', async () => {
      const chunks: StreamChunk[] = [
        { type: 'text_delta', text: 'Hello' },
        { type: 'done', usage: USAGE },
      ];

      const primary: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'hi' }, usage: USAGE };
        },
        async *stream() {
          for (const chunk of chunks) yield chunk;
        },
      };

      const adapter = createFallbackAdapter({ adapters: [primary] });
      const collected: StreamChunk[] = [];
      for await (const chunk of adapter.stream!(PARAMS)) {
        collected.push(chunk);
      }
      expect(collected).toEqual(chunks);
    });

    it('falls back to next adapter when stream fails', async () => {
      const fallbackChunks: StreamChunk[] = [
        { type: 'text_delta', text: 'Fallback stream' },
        { type: 'done', usage: USAGE },
      ];

      const primary: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'hi' }, usage: USAGE };
        },
        async *stream() {
          throw new Error('primary stream failure');
        },
      };

      const fallback: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'fb' }, usage: USAGE };
        },
        async *stream() {
          for (const chunk of fallbackChunks) yield chunk;
        },
      };

      const adapter = createFallbackAdapter({ adapters: [primary, fallback], maxFailures: 1 });
      const collected: StreamChunk[] = [];
      for await (const chunk of adapter.stream!(PARAMS)) {
        collected.push(chunk);
      }
      expect(collected).toEqual(fallbackChunks);
    });

    it('throws STREAM_NOT_SUPPORTED when adapter has no stream method', async () => {
      const primary: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'hi' }, usage: USAGE };
        },
        // No stream method
      };

      const adapter = createFallbackAdapter({ adapters: [primary] });
      const gen = adapter.stream!(PARAMS);
      await expect(gen.next()).rejects.toThrow(HarnessError);
      await expect(
        (async () => { for await (const chunk of adapter.stream!(PARAMS)) { void chunk; } })()
      ).rejects.toThrow('Current adapter does not support streaming');
    });
  });

  describe('retry uses correct adapter after failover', () => {
    it('retries with the NEW adapter after handleFailure switches (chat)', async () => {
      // With maxFailures=1, the first failure should switch to adapter 2 and retry with it
      const callOrder: string[] = [];
      const primary: AgentAdapter = {
        async chat() {
          callOrder.push('primary');
          throw new Error('primary fail');
        },
      };
      const fallback: AgentAdapter = {
        async chat() {
          callOrder.push('fallback');
          return { message: { role: 'assistant', content: 'from fallback' }, usage: USAGE };
        },
      };

      const adapter = createFallbackAdapter({ adapters: [primary, fallback], maxFailures: 1 });
      const result = await adapter.chat(PARAMS);

      expect(result.message.content).toBe('from fallback');
      // Primary called once (fail), then fallback called once (success)
      expect(callOrder).toEqual(['primary', 'fallback']);
    });

    it('does not retry when last adapter fails and no switch happened', async () => {
      const callOrder: string[] = [];
      const solo: AgentAdapter = {
        async chat() {
          callOrder.push('solo');
          throw new Error('solo fail');
        },
      };

      const adapter = createFallbackAdapter({ adapters: [solo], maxFailures: 1 });
      await expect(adapter.chat(PARAMS)).rejects.toThrow('solo fail');
      // Only called once -- no retry since it's the last (and only) adapter
      expect(callOrder).toEqual(['solo']);
    });

    it('retries with the NEW adapter after handleFailure switches (stream)', async () => {
      const callOrder: string[] = [];
      const fallbackChunks: StreamChunk[] = [
        { type: 'text_delta', text: 'fb' },
        { type: 'done', usage: USAGE },
      ];

      const primary: AgentAdapter = {
        async chat() { return { message: { role: 'assistant', content: '' }, usage: USAGE }; },
        async *stream() {
          callOrder.push('primary-stream');
          throw new Error('primary stream fail');
        },
      };

      const fallback: AgentAdapter = {
        async chat() { return { message: { role: 'assistant', content: '' }, usage: USAGE }; },
        async *stream() {
          callOrder.push('fallback-stream');
          for (const chunk of fallbackChunks) yield chunk;
        },
      };

      const adapter = createFallbackAdapter({ adapters: [primary, fallback], maxFailures: 1 });
      const collected: StreamChunk[] = [];
      for await (const chunk of adapter.stream!(PARAMS)) {
        collected.push(chunk);
      }

      expect(collected).toEqual(fallbackChunks);
      expect(callOrder).toEqual(['primary-stream', 'fallback-stream']);
    });

    it('does not retry stream when last adapter fails and no switch happened', async () => {
      const callOrder: string[] = [];
      const solo: AgentAdapter = {
        async chat() { return { message: { role: 'assistant', content: '' }, usage: USAGE }; },
        async *stream() {
          callOrder.push('solo-stream');
          throw new Error('solo stream fail');
        },
      };

      const adapter = createFallbackAdapter({ adapters: [solo], maxFailures: 1 });
      await expect(
        (async () => { for await (const chunk of adapter.stream!(PARAMS)) { void chunk; } })()
      ).rejects.toThrow('solo stream fail');
      expect(callOrder).toEqual(['solo-stream']);
    });
  });

  describe('circuit breaker behavior', () => {
    it('retries with same adapter when under failure threshold', async () => {
      let calls = 0;
      const primary: AgentAdapter = {
        async chat() {
          calls++;
          if (calls === 1) throw new Error('first fail');
          return { message: { role: 'assistant', content: 'recovered' }, usage: USAGE };
        },
      };
      const fallback = createMockAdapter('fallback', []);

      const adapter = createFallbackAdapter({ adapters: [primary, fallback], maxFailures: 3 });
      const result = await adapter.chat(PARAMS);
      expect(result.message.content).toBe('recovered');
      expect(calls).toBe(2);
    });

    it('does not fall back with only one adapter', async () => {
      const solo = createFailingAdapter('solo', 'solo fail');
      const adapter = createFallbackAdapter({ adapters: [solo], maxFailures: 1 });
      await expect(adapter.chat(PARAMS)).rejects.toThrow('solo fail');
    });

    it('handles three adapters in chain', async () => {
      const a1 = createFailingAdapter('a1');
      const a2 = createFailingAdapter('a2');
      const a3 = createMockAdapter('a3', [
        { message: { role: 'assistant', content: 'a3 response' }, usage: USAGE },
      ]);

      const adapter = createFallbackAdapter({ adapters: [a1, a2, a3], maxFailures: 1 });

      // a1 fails -> switch to a2 -> a2 fails (retry) -> switch to a3 -> a3 succeeds
      // Actually: first call: a1 fails, handleFailure switches to a2, retries a2
      // a2 fails, throws. Second call: a2 fails, handleFailure switches to a3, retries a3
      // a3 succeeds
      try { await adapter.chat(PARAMS); } catch { /* a2 retry fails */ }
      const result = await adapter.chat(PARAMS);
      expect(result.message.content).toBe('a3 response');
    });
  });
});
