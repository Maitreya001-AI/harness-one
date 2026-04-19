/**
 * Adapter-retry integration tests for {@link AgentLoop}.
 *
 * Covers rate-limit retry, non-retryable auth errors, network-error
 * opt-in via `retryableErrors`, abort-during-backoff, iteration-counter
 * invariants across retries, and the streaming-path equivalent.
 */

import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../agent-loop.js';
import type { AgentAdapter } from '../types.js';
import type { AgentEvent } from '../events.js';
import { collectEvents, USAGE } from './agent-loop-test-fixtures.js';

describe('AgentLoop adapter retry on rate-limit errors', () => {
  it('retries rate-limit errors with exponential backoff and succeeds', async () => {
    let callCount = 0;
    const adapter: AgentAdapter = {
      async chat() {
        callCount++;
        if (callCount <= 2) {
          throw new Error('429 Too Many Requests');
        }
        return { message: { role: 'assistant', content: 'Success after retry' }, usage: USAGE };
      },
    };

    const loop = new AgentLoop({
      adapter,
      maxAdapterRetries: 3,
      baseRetryDelayMs: 1,
    });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

    expect(callCount).toBe(3);

    const msgEvent = events.find((e) => e.type === 'message');
    expect(msgEvent).toBeDefined();
    expect((msgEvent as Extract<AgentEvent, { type: 'message' }>).message.content).toBe('Success after retry');

    const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.reason).toBe('end_turn');
  });

  it('gives up after maxAdapterRetries exhausted and yields error', async () => {
    let callCount = 0;
    const adapter: AgentAdapter = {
      async chat() {
        callCount++;
        throw new Error('429 rate limit exceeded');
      },
    };

    const loop = new AgentLoop({
      adapter,
      maxAdapterRetries: 2,
      baseRetryDelayMs: 1,
    });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

    expect(callCount).toBe(3);
    expect(events.find((e) => e.type === 'error')).toBeDefined();

    const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.reason).toBe('error');
  });

  it('does not retry non-retryable errors (e.g. auth errors)', async () => {
    let callCount = 0;
    const adapter: AgentAdapter = {
      async chat() {
        callCount++;
        throw new Error('401 unauthorized - invalid api key');
      },
    };

    const loop = new AgentLoop({
      adapter,
      maxAdapterRetries: 3,
      baseRetryDelayMs: 1,
    });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

    expect(callCount).toBe(1);
    expect(events.find((e) => e.type === 'error')).toBeDefined();

    const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.reason).toBe('error');
  });

  it('retries network errors when included in retryableErrors', async () => {
    let callCount = 0;
    const adapter: AgentAdapter = {
      async chat() {
        callCount++;
        if (callCount <= 1) {
          throw new Error('ECONNREFUSED network error');
        }
        return { message: { role: 'assistant', content: 'Recovered' }, usage: USAGE };
      },
    };

    const loop = new AgentLoop({
      adapter,
      maxAdapterRetries: 3,
      baseRetryDelayMs: 1,
      retryableErrors: ['ADAPTER_RATE_LIMIT', 'ADAPTER_NETWORK'],
    });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

    expect(callCount).toBe(2);

    const msgEvent = events.find((e) => e.type === 'message');
    expect(msgEvent).toBeDefined();
    expect((msgEvent as Extract<AgentEvent, { type: 'message' }>).message.content).toBe('Recovered');

    const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
    expect(done.reason).toBe('end_turn');
  });

  it('does not retry when abort signal fires during backoff', async () => {
    const controller = new AbortController();
    let callCount = 0;
    const adapter: AgentAdapter = {
      async chat() {
        callCount++;
        if (callCount === 1) {
          setTimeout(() => controller.abort(), 0);
          throw new Error('429 rate limit');
        }
        return { message: { role: 'assistant', content: 'should not reach' }, usage: USAGE };
      },
    };

    const loop = new AgentLoop({
      adapter,
      maxAdapterRetries: 3,
      baseRetryDelayMs: 50,
      signal: controller.signal,
    });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

    expect(callCount).toBe(1);

    const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.reason).toBe('aborted');
  });

  it('does not retry within the same iteration (iteration counter unchanged)', async () => {
    let callCount = 0;
    const adapter: AgentAdapter = {
      async chat() {
        callCount++;
        if (callCount === 1) {
          throw new Error('Too many requests 429');
        }
        return { message: { role: 'assistant', content: 'ok' }, usage: USAGE };
      },
    };

    const loop = new AgentLoop({
      adapter,
      maxAdapterRetries: 3,
      baseRetryDelayMs: 1,
    });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

    const iterStarts = events.filter((e) => e.type === 'iteration_start');
    expect(iterStarts).toHaveLength(1);
    expect(callCount).toBe(2);

    const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
    expect(done.reason).toBe('end_turn');
  });

  it('retries streaming rate-limit errors', async () => {
    let callCount = 0;
    const adapter: AgentAdapter = {
      async chat() {
        return { message: { role: 'assistant', content: 'fallback' }, usage: USAGE };
      },
      async *stream() {
        callCount++;
        if (callCount <= 1) {
          throw new Error('429 rate limit');
        }
        yield { type: 'text_delta' as const, text: 'Streamed OK' };
        yield { type: 'done' as const, usage: USAGE };
      },
    };

    const loop = new AgentLoop({
      adapter,
      streaming: true,
      maxAdapterRetries: 3,
      baseRetryDelayMs: 1,
      retryableErrors: ['ADAPTER_RATE_LIMIT'],
    });
    const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

    expect(callCount).toBe(2);

    const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.reason).toBe('end_turn');
  });
});
