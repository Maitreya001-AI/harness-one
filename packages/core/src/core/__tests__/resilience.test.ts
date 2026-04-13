import { describe, it, expect, vi } from 'vitest';
import { createResilientLoop } from '../resilience.js';
import type { AgentAdapter, ChatResponse, Message, ToolCallRequest } from '../types.js';
import type { AgentEvent } from '../events.js';

/** Helper: collect all events from an async generator. */
async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

const USAGE = { inputTokens: 10, outputTokens: 5 };

/**
 * Create a mock adapter that returns responses in sequence.
 * After all responses are exhausted, returns the last one.
 */
function createMockAdapter(responses: ChatResponse[]): AgentAdapter & { calls: { messages: readonly Message[] }[] } {
  let callIndex = 0;
  const calls: { messages: readonly Message[] }[] = [];
  return {
    calls,
    async chat(params) {
      calls.push({ messages: params.messages });
      const resp = responses[Math.min(callIndex++, responses.length - 1)];
      return resp;
    },
  };
}

describe('createResilientLoop', () => {
  describe('inner loop succeeds on first try', () => {
    it('yields events from a single successful inner loop run without retry', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Hello!' }, usage: USAGE },
      ]);

      const resilient = createResilientLoop({
        loopConfig: { adapter },
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Hi' }]));

      // Should have iteration_start, message, done -- no warning about retries
      const warningEvents = events.filter(e => e.type === 'warning');
      expect(warningEvents).toBeDefined();
      const retryWarnings = warningEvents.filter(
        e => e.type === 'warning' && (e as Extract<AgentEvent, { type: 'warning' }>).message.includes('Resilient loop retry'),
      );
      expect(retryWarnings).toHaveLength(0);

      const doneEvent = events.find(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent).toBeDefined();
      expect(doneEvent.reason).toBe('end_turn');
    });
  });

  describe('inner loop hits max_iterations', () => {
    it('triggers retry with summary from onRetry callback', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };
      let callCount = 0;

      // With maxIterations=1:
      //   Inner loop attempt 0: call 1 returns tool call, tool executes,
      //     iteration 2 > maxIterations -> done(max_iterations)
      //   Retry 1 (attempt=1): call 2 returns final answer -> done(end_turn)
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount <= 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'Done after retry' }, usage: USAGE };
        },
      };

      const onRetry = vi.fn().mockResolvedValue({
        summary: 'Progress so far: partial work done',
      });

      const resilient = createResilientLoop({
        loopConfig: {
          adapter,
          maxIterations: 1,
          onToolCall: async () => 'ok',
        },
        maxOuterRetries: 2,
        onRetry,
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Do work' }]));

      // onRetry should have been called with attempt=1 and reason='max_iterations'
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 1,
          reason: 'max_iterations',
        }),
      );

      // Should have a warning event about the retry
      const retryWarnings = events.filter(
        e => e.type === 'warning' && (e as Extract<AgentEvent, { type: 'warning' }>).message.includes('Resilient loop retry'),
      );
      expect(retryWarnings.length).toBeGreaterThanOrEqual(1);

      // Should ultimately succeed
      const doneEvent = events.find(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent).toBeDefined();
      expect(doneEvent.reason).toBe('end_turn');
    });
  });

  describe('inner loop hits token_budget', () => {
    it('triggers retry on token budget exceeded', async () => {
      let callCount = 0;
      const highUsage = { inputTokens: 600, outputTokens: 600 };

      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            // First call uses lots of tokens, will exceed budget of 100
            return { message: { role: 'assistant', content: 'Big response' }, usage: highUsage };
          }
          // After retry, return a small response
          return { message: { role: 'assistant', content: 'Done' }, usage: USAGE };
        },
      };

      const onRetry = vi.fn().mockResolvedValue({ summary: 'Resuming after token budget' });

      const resilient = createResilientLoop({
        loopConfig: { adapter, maxTotalTokens: 100 },
        maxOuterRetries: 1,
        onRetry,
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Go' }]));

      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'token_budget' }),
      );

      const doneEvent = events.find(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent).toBeDefined();
      expect(doneEvent.reason).toBe('end_turn');
    });
  });

  describe('inner loop hits error', () => {
    it('triggers retry on error done reason', async () => {
      let callCount = 0;

      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            throw new Error('Network error');
          }
          return { message: { role: 'assistant', content: 'Recovered' }, usage: USAGE };
        },
      };

      const onRetry = vi.fn().mockResolvedValue({ summary: 'Retrying after error' });

      const resilient = createResilientLoop({
        loopConfig: { adapter },
        maxOuterRetries: 1,
        onRetry,
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Go' }]));

      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'error' }),
      );

      const doneEvent = events.find(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent).toBeDefined();
      expect(doneEvent.reason).toBe('end_turn');
    });
  });

  describe('retry succeeds with combined events', () => {
    it('yields events from both inner loop attempts', async () => {
      let callCount = 0;
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'work', arguments: '{}' };

      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount <= 2) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'Final answer' }, usage: USAGE };
        },
      };

      const onRetry = vi.fn().mockResolvedValue({
        summary: 'Continue from where we left off',
      });

      const resilient = createResilientLoop({
        loopConfig: { adapter, maxIterations: 1, onToolCall: async () => 'result' },
        maxOuterRetries: 2,
        onRetry,
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Go' }]));

      // Should have iteration_start events from both runs
      const iterationStarts = events.filter(e => e.type === 'iteration_start');
      expect(iterationStarts.length).toBeGreaterThanOrEqual(2);

      // Should have the final message
      const messageEvents = events.filter(e => e.type === 'message');
      expect(messageEvents.length).toBeGreaterThanOrEqual(1);

      // Done should be end_turn from the successful retry
      const doneEvent = events.find(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.reason).toBe('end_turn');
    });
  });

  describe('all retries exhausted', () => {
    it('yields final error when all retries are used up', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };

      // Always return tool calls to force max_iterations on every attempt
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
        },
      };

      const onRetry = vi.fn().mockResolvedValue({ summary: 'Try again' });

      const resilient = createResilientLoop({
        loopConfig: { adapter, maxIterations: 1, onToolCall: async () => 'ok' },
        maxOuterRetries: 2,
        onRetry,
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Go' }]));

      // onRetry called for each retry attempt
      expect(onRetry).toHaveBeenCalledTimes(2);

      // Should end with an error done event (the last inner loop's failure)
      const doneEvents = events.filter(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>[];
      const lastDone = doneEvents[doneEvents.length - 1];
      expect(lastDone).toBeDefined();
      // The last done reason should be a failure reason since all retries exhausted
      expect(['max_iterations', 'token_budget', 'error']).toContain(lastDone.reason);
    });
  });

  describe('abort during retry', () => {
    it('stops immediately when abort is called during retry', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };
      let callCount = 0;

      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount <= 2) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'Done' }, usage: USAGE };
        },
      };

      const resilient = createResilientLoop({
        loopConfig: { adapter, maxIterations: 1, onToolCall: async () => 'ok' },
        maxOuterRetries: 3,
        onRetry: async () => {
          // Abort during the onRetry callback
          resilient.abort();
          return { summary: 'Aborted' };
        },
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Go' }]));

      // Should have an aborted done event
      const doneEvents = events.filter(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>[];
      const lastDone = doneEvents[doneEvents.length - 1];
      expect(lastDone).toBeDefined();
      expect(lastDone.reason).toBe('aborted');
    });
  });

  describe('warning events emitted for each retry', () => {
    it('emits a warning event with retry count for each outer retry', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };

      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
        },
      };

      const onRetry = vi.fn().mockResolvedValue({ summary: 'Retry' });

      const resilient = createResilientLoop({
        loopConfig: { adapter, maxIterations: 1, onToolCall: async () => 'ok' },
        maxOuterRetries: 3,
        onRetry,
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Go' }]));

      const retryWarnings = events.filter(
        e => e.type === 'warning' && (e as Extract<AgentEvent, { type: 'warning' }>).message.includes('Resilient loop retry'),
      );

      // Should have warning for each retry (3 retries)
      expect(retryWarnings).toHaveLength(3);
      expect((retryWarnings[0] as Extract<AgentEvent, { type: 'warning' }>).message).toContain('1/3');
      expect((retryWarnings[1] as Extract<AgentEvent, { type: 'warning' }>).message).toContain('2/3');
      expect((retryWarnings[2] as Extract<AgentEvent, { type: 'warning' }>).message).toContain('3/3');
    });
  });

  describe('end_turn and aborted are not retried', () => {
    it('passes through end_turn without retry', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Done' }, usage: USAGE },
      ]);

      const onRetry = vi.fn();

      const resilient = createResilientLoop({
        loopConfig: { adapter },
        maxOuterRetries: 2,
        onRetry,
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Hi' }]));

      expect(onRetry).not.toHaveBeenCalled();
      const doneEvent = events.find(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.reason).toBe('end_turn');
    });

    it('passes through aborted without retry', async () => {
      const controller = new AbortController();
      controller.abort(); // pre-abort

      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Never' }, usage: USAGE },
      ]);

      const onRetry = vi.fn();

      const resilient = createResilientLoop({
        loopConfig: { adapter, signal: controller.signal },
        maxOuterRetries: 2,
        onRetry,
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Hi' }]));

      expect(onRetry).not.toHaveBeenCalled();
      const doneEvent = events.find(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.reason).toBe('aborted');
    });
  });

  describe('onRetry not provided', () => {
    it('retries with just the original messages when onRetry is not provided', async () => {
      let callCount = 0;
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };

      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount <= 2) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'Done' }, usage: USAGE };
        },
      };

      const resilient = createResilientLoop({
        loopConfig: { adapter, maxIterations: 1, onToolCall: async () => 'ok' },
        maxOuterRetries: 2,
        // No onRetry provided
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Go' }]));

      const doneEvent = events.find(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent).toBeDefined();
      expect(doneEvent.reason).toBe('end_turn');
    });
  });

  describe('onRetry provides additionalMessages', () => {
    it('includes additional messages from onRetry in the retry run', async () => {
      let callCount = 0;
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };
      const chatCalls: { messages: readonly Message[] }[] = [];

      const adapter: AgentAdapter = {
        async chat(params) {
          chatCalls.push({ messages: params.messages });
          callCount++;
          if (callCount <= 2) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'Done' }, usage: USAGE };
        },
      };

      const onRetry = vi.fn().mockResolvedValue({
        summary: 'Progress summary',
        additionalMessages: [
          { role: 'user', content: 'Please continue from where you left off' } as Message,
        ],
      });

      const resilient = createResilientLoop({
        loopConfig: { adapter, maxIterations: 1, onToolCall: async () => 'ok' },
        maxOuterRetries: 2,
        onRetry,
      });

      await collectEvents(resilient.run([{ role: 'user', content: 'Go' }]));

      // After retry, the adapter should receive messages including the system summary and additional messages
      // The retry call is the 3rd adapter call (calls 1-2 were the failing inner loop)
      expect(chatCalls.length).toBeGreaterThanOrEqual(3);
      const retryMessages = chatCalls[2].messages;

      // Should contain the system message with summary
      const systemMsg = retryMessages.find(m => m.role === 'system' && m.content.includes('Progress summary'));
      expect(systemMsg).toBeDefined();

      // Should contain the additional user message
      const additionalMsg = retryMessages.find(m => m.role === 'user' && m.content === 'Please continue from where you left off');
      expect(additionalMsg).toBeDefined();
    });
  });

  describe('default maxOuterRetries', () => {
    it('defaults to 2 outer retries when not specified', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };

      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
        },
      };

      const onRetry = vi.fn().mockResolvedValue({ summary: 'Retry' });

      const resilient = createResilientLoop({
        loopConfig: { adapter, maxIterations: 1, onToolCall: async () => 'ok' },
        // No maxOuterRetries specified, should default to 2
        onRetry,
      });

      const events = await collectEvents(resilient.run([{ role: 'user', content: 'Go' }]));

      expect(onRetry).toHaveBeenCalledTimes(2);

      const retryWarnings = events.filter(
        e => e.type === 'warning' && (e as Extract<AgentEvent, { type: 'warning' }>).message.includes('Resilient loop retry'),
      );
      expect(retryWarnings).toHaveLength(2);
    });
  });

  describe('onRetry receives conversationSoFar', () => {
    it('passes the conversation messages to onRetry', async () => {
      let callCount = 0;
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };

      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount <= 2) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'Done' }, usage: USAGE };
        },
      };

      const onRetry = vi.fn().mockResolvedValue({ summary: 'Retry' });

      const resilient = createResilientLoop({
        loopConfig: { adapter, maxIterations: 1, onToolCall: async () => 'ok' },
        maxOuterRetries: 1,
        onRetry,
      });

      const originalMessages: Message[] = [{ role: 'user', content: 'Go' }];
      await collectEvents(resilient.run(originalMessages));

      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationSoFar: expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: 'Go' }),
          ]),
        }),
      );
    });
  });

  // =====================================================================
  // CQ-015: ResilientLoop must dispose inner AgentLoop to release resources
  // =====================================================================
  describe('CQ-015: inner AgentLoop is disposed after each attempt', () => {
    it('calls dispose() on every inner loop created during retries', async () => {
      // Instrument AgentLoop.prototype.dispose so we can count calls.
      const { AgentLoop } = await import('../agent-loop.js');
      const disposeSpy = vi.spyOn(AgentLoop.prototype, 'dispose');

      try {
        const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };
        let callCount = 0;

        const adapter: AgentAdapter = {
          async chat() {
            callCount++;
            // First inner loop exhausts max_iterations, second succeeds
            if (callCount <= 1) {
              return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
            }
            return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
          },
        };

        const onRetry = vi.fn().mockResolvedValue({ summary: 'retry' });
        const resilient = createResilientLoop({
          loopConfig: { adapter, maxIterations: 1, onToolCall: async () => 'ok' },
          maxOuterRetries: 1,
          onRetry,
        });

        await collectEvents(resilient.run([{ role: 'user', content: 'Go' }]));

        // Two inner loops were created (first + retry) — both must have been disposed.
        expect(disposeSpy).toHaveBeenCalledTimes(2);
      } finally {
        disposeSpy.mockRestore();
      }
    });

    it('disposes inner loop even when iterator throws', async () => {
      const { AgentLoop } = await import('../agent-loop.js');
      const disposeSpy = vi.spyOn(AgentLoop.prototype, 'dispose');

      try {
        const adapter: AgentAdapter = {
          async chat() {
            throw new Error('persistent adapter failure');
          },
        };

        const resilient = createResilientLoop({
          loopConfig: { adapter },
          maxOuterRetries: 0, // No retries — single attempt that will error
        });

        await collectEvents(resilient.run([{ role: 'user', content: 'Go' }]));

        // Single inner loop must still have been disposed.
        expect(disposeSpy).toHaveBeenCalledTimes(1);
      } finally {
        disposeSpy.mockRestore();
      }
    });

    it('disposes inner loop on successful first-try completion', async () => {
      const { AgentLoop } = await import('../agent-loop.js');
      const disposeSpy = vi.spyOn(AgentLoop.prototype, 'dispose');

      try {
        const adapter = createMockAdapter([
          { message: { role: 'assistant', content: 'Hello' }, usage: USAGE },
        ]);

        const resilient = createResilientLoop({
          loopConfig: { adapter },
        });

        await collectEvents(resilient.run([{ role: 'user', content: 'Hi' }]));

        expect(disposeSpy).toHaveBeenCalledTimes(1);
      } finally {
        disposeSpy.mockRestore();
      }
    });
  });
});
