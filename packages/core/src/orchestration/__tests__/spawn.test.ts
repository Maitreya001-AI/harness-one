import { describe, it, expect, vi } from 'vitest';
import { spawnSubAgent } from '../spawn.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';
import type { AgentAdapter, ChatResponse, ToolCallRequest } from '../../core/types.js';

const USAGE = { inputTokens: 10, outputTokens: 5 };

/** Helper: create a mock adapter that returns responses in sequence. */
function createMockAdapter(responses: ChatResponse[]): AgentAdapter {
  let callIndex = 0;
  return {
    async chat() {
      const response = responses[callIndex];
      if (!response) throw new Error('No more mock responses');
      callIndex++;
      return response;
    },
  };
}

describe('spawnSubAgent', () => {
  describe('happy path', () => {
    it('returns messages and usage for a basic spawn', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Hello from sub-agent' }, usage: USAGE },
      ]);

      const result = await spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.doneReason).toBe('end_turn');
      expect(result.usage).toEqual(USAGE);
      // Should contain the original user message + assistant reply
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual({ role: 'user', content: 'Hi' });
      expect(result.messages[1]).toEqual({ role: 'assistant', content: 'Hello from sub-agent' });
    });

    it('reflects cumulative token usage', async () => {
      const toolCall: ToolCallRequest = { id: 'tc-1', name: 'echo', arguments: '{}' };
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: { inputTokens: 20, outputTokens: 10 } },
        { message: { role: 'assistant', content: 'Done' }, usage: { inputTokens: 30, outputTokens: 15 } },
      ]);

      const result = await spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'go' }],
        onToolCall: async () => 'ok',
      });

      expect(result.usage.inputTokens).toBe(50);
      expect(result.usage.outputTokens).toBe(25);
    });

    it('includes tool call results in messages', async () => {
      const toolCall: ToolCallRequest = { id: 'tc-1', name: 'search', arguments: '{"q":"test"}' };
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE },
        { message: { role: 'assistant', content: 'Found it' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn().mockResolvedValue('search result');

      const result = await spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'search' }],
        onToolCall,
      });

      expect(onToolCall).toHaveBeenCalledWith(toolCall);
      // user, tool result (from event), assistant (final message event)
      // Note: intermediate assistant messages with tool calls are not emitted as 'message' events
      expect(result.messages).toHaveLength(3);
      const toolMsg = result.messages[1];
      expect(toolMsg.role).toBe('tool');
      if (toolMsg.role === 'tool') {
        expect(toolMsg.toolCallId).toBe('tc-1');
        expect(toolMsg.content).toBe('search result');
      }
      expect(result.messages[2]).toEqual({ role: 'assistant', content: 'Found it' });
    });

    it('returns frozen result and messages', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Hi' }, usage: USAGE },
      ]);

      const result = await spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.messages)).toBe(true);
      expect(Object.isFrozen(result.usage)).toBe(true);
    });
  });

  describe('budget reasons resolve normally (caller-set limits)', () => {
    it('reports max_iterations doneReason without throwing', async () => {
      // Adapter always returns tool calls, so loop hits max iterations
      const toolCall: ToolCallRequest = { id: 'tc-1', name: 'loop', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          return {
            message: { role: 'assistant' as const, content: '', toolCalls: [{ ...toolCall, id: `tc-${callCount}` }] },
            usage: USAGE,
          };
        },
      };

      const result = await spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'go' }],
        onToolCall: async () => 'ok',
        maxIterations: 2,
      });

      expect(result.doneReason).toBe('max_iterations');
    });

    it('uses default maxIterations of 10', async () => {
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          return {
            message: { role: 'assistant' as const, content: '', toolCalls: [{ id: `tc-${callCount}`, name: 'loop', arguments: '{}' }] },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };

      const result = await spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'go' }],
        onToolCall: async () => 'ok',
      });

      expect(result.doneReason).toBe('max_iterations');
      // Should have hit max at iteration 11 (> 10), so 10 adapter calls
      expect(callCount).toBe(10);
    });
  });

  describe('failure contract — throws on error/aborted', () => {
    it('throws CORE_ABORTED when caller signal is pre-aborted', async () => {
      const ac = new AbortController();
      ac.abort();

      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'should not reach' }, usage: USAGE },
      ]);

      const promise = spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'Hi' }],
        signal: ac.signal,
      });

      await expect(promise).rejects.toBeInstanceOf(HarnessError);
      await expect(promise).rejects.toMatchObject({
        code: HarnessErrorCode.CORE_ABORTED,
      });
    });

    it('throws CORE_ABORTED when signal aborts mid-flight', async () => {
      const ac = new AbortController();

      const adapter: AgentAdapter = {
        async chat() {
          // Delay long enough for the abort to land mid-iteration.
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 1000);
            ac.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                reject(new Error('aborted by signal'));
              },
              { once: true },
            );
          });
          return { message: { role: 'assistant' as const, content: 'never' }, usage: USAGE };
        },
      };

      const pending = spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'Hi' }],
        signal: ac.signal,
      });
      // Schedule the abort on the next tick so the chat() is in flight.
      queueMicrotask(() => ac.abort());

      await expect(pending).rejects.toMatchObject({
        code: HarnessErrorCode.CORE_ABORTED,
      });
    });

    it('throws ADAPTER_ERROR with the original error as cause when adapter rejects', async () => {
      const original = new Error('upstream API blew up');
      const adapter: AgentAdapter = {
        async chat() {
          throw original;
        },
      };

      const promise = spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_ERROR);
      // The cause should chain back to the original failure (possibly
      // wrapped by the adapter caller, but the leaf message should match).
      const cause = (err as HarnessError).cause;
      expect(cause).toBeDefined();
      expect((cause as Error)?.message).toContain('upstream API blew up');
      // The HarnessError message should embed the cause's message for grep-ability.
      expect((err as HarnessError).message).toContain('upstream API blew up');
    });

    it('preserves the FIRST error event when multiple errors land', async () => {
      // The adapter throws on the first call. The loop's downstream
      // teardown might emit further error events (cleanup noise); we
      // want the originating cause, not the noise.
      const original = new Error('the real cause');
      const adapter: AgentAdapter = {
        async chat() {
          throw original;
        },
      };
      const promise = spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      const err = await promise.catch((e: unknown) => e);
      const cause = (err as HarnessError).cause;
      expect((cause as Error)?.message).toContain('the real cause');
    });
  });

  describe('config option spreads — optional fields plumb through', () => {
    it('forwards maxTotalTokens, tools, onToolCall, streaming when supplied', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'ok' }, usage: USAGE },
      ]);
      // Pass every optional field so the conditional spreads at
      // spawn.ts:47/49/51 are exercised.
      const result = await spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'hi' }],
        maxTotalTokens: 1_000_000,
        signal: new AbortController().signal,
        tools: [
          {
            name: 't',
            description: 'd',
            parameters: { type: 'object', properties: {} },
          },
        ],
        onToolCall: async () => 'never-called',
        streaming: false,
      });
      expect(result.doneReason).toBe('end_turn');
    });
  });

  describe('tool_result message serialisation', () => {
    it('JSON-serialises non-string tool_result payloads', async () => {
      const toolCall = { id: 'tc-1', name: 't', arguments: '{}' };
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE },
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const result = await spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'go' }],
        // Returning an object → JSON.stringify branch on spawn.ts:66.
        onToolCall: async () => ({ shape: 'object', value: 42 }),
      });
      const toolMsg = result.messages[1];
      expect(toolMsg.role).toBe('tool');
      if (toolMsg.role === 'tool') {
        expect(toolMsg.content).toBe('{"shape":"object","value":42}');
      }
    });
  });

  describe('failure contract is grep-able', () => {
    it('throw message includes "spawnSubAgent" prefix so logs are searchable', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('boom');
        },
      };
      const promise = spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      const err = (await promise.catch((e: unknown) => e)) as HarnessError;
      expect(err.message).toContain('spawnSubAgent');
    });

    it('throw carries an actionable suggestion field', async () => {
      const ac = new AbortController();
      ac.abort();
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'x' }, usage: USAGE },
      ]);
      const err = (await spawnSubAgent({
        adapter,
        messages: [{ role: 'user', content: 'Hi' }],
        signal: ac.signal,
      }).catch((e: unknown) => e)) as HarnessError;
      expect(err.suggestion).toBeDefined();
      expect(err.suggestion!.length).toBeGreaterThan(0);
    });
  });
});
