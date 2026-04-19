/**
 * Unit tests for `streaming-retry.ts`.
 *
 * The helper is the pump-and-decide for one streaming adapter attempt.
 * It forwards delta/warning events verbatim, buffers the single terminal
 * `{type:'error'}` event, and — at stream end — reports success, retry,
 * or terminal-failure. These tests fence each behaviour the outer retry
 * loop in `adapter-caller.ts` relies on.
 */

import { describe, it, expect, vi } from 'vitest';
import { runStreamingAttempt } from '../streaming-retry.js';
import type { StreamingAttemptOutcome } from '../streaming-retry.js';
import type { StreamHandler, StreamResult } from '../stream-handler.js';
import type { RetryPolicy } from '../retry-policy.js';
import type { AgentEvent } from '../events.js';
import type { Message } from '../types.js';
import { HarnessError, HarnessErrorCode } from '../errors.js';

type PolicyStub = Pick<
  RetryPolicy,
  'isRetryableCategory' | 'maxRetries' | 'recordSuccess' | 'recordFailure'
>;

function makePolicy(opts: {
  retryable?: (cat: HarnessErrorCode) => boolean;
  maxRetries?: number;
} = {}): PolicyStub & {
  successes: number;
  failures: number;
} {
  let successes = 0;
  let failures = 0;
  return {
    isRetryableCategory: opts.retryable ?? ((c) => c === HarnessErrorCode.ADAPTER_NETWORK),
    maxRetries: opts.maxRetries ?? 3,
    recordSuccess: () => {
      successes += 1;
    },
    recordFailure: () => {
      failures += 1;
    },
    get successes(): number {
      return successes;
    },
    get failures(): number {
      return failures;
    },
  };
}

/** Build a StreamHandler whose `handle()` yields `events` then returns `result`. */
function makeHandler(
  events: readonly AgentEvent[],
  result: StreamResult,
  hooks: { onReturn?: () => void } = {},
): StreamHandler {
  return {
    async *handle(): AsyncGenerator<AgentEvent, StreamResult> {
      try {
        for (const evt of events) {
          yield evt;
        }
        return result;
      } finally {
        hooks.onReturn?.();
      }
    },
  };
}

const MSG: Message = { role: 'assistant', content: 'hi' };
const CONV: readonly Message[] = [{ role: 'user', content: 'hello' }];

describe('runStreamingAttempt — success', () => {
  it('forwards delta events and returns success with usage + bytesRead', async () => {
    const handler = makeHandler(
      [
        { type: 'text_delta', text: 'hi' },
        { type: 'tool_call_delta', toolCall: { name: 'echo' } },
        { type: 'warning', message: 'test' },
      ],
      {
        ok: true,
        message: MSG,
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        bytesRead: 42,
      },
    );
    const policy = makePolicy();
    const gen = runStreamingAttempt({
      streamHandler: handler,
      policy,
      conversation: CONV,
      cumulativeStreamBytesSoFar: 0,
      attempt: 0,
    });
    const seen: AgentEvent[] = [];
    let outcome: StreamingAttemptOutcome | undefined;
    while (true) {
      const step = await gen.next();
      if (step.done) {
        outcome = step.value;
        break;
      }
      seen.push(step.value);
    }
    expect(seen).toHaveLength(3);
    expect(seen.map((e) => e.type)).toEqual(['text_delta', 'tool_call_delta', 'warning']);
    expect(outcome).toEqual({
      kind: 'success',
      message: MSG,
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      bytesRead: 42,
    });
    expect(policy.successes).toBe(1);
    expect(policy.failures).toBe(0);
  });

  it('calls policy.recordSuccess exactly once on success', async () => {
    const handler = makeHandler(
      [],
      {
        ok: true,
        message: MSG,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        bytesRead: 0,
      },
    );
    const recordSuccess = vi.fn();
    const policy: PolicyStub = {
      isRetryableCategory: () => true,
      maxRetries: 3,
      recordSuccess,
      recordFailure: vi.fn(),
    };
    const gen = runStreamingAttempt({
      streamHandler: handler,
      policy,
      conversation: CONV,
      cumulativeStreamBytesSoFar: 0,
      attempt: 0,
    });
    while (!(await gen.next()).done) {
      /* drain */
    }
    expect(recordSuccess).toHaveBeenCalledOnce();
  });
});

describe('runStreamingAttempt — retry path', () => {
  it('returns retry outcome when error is retryable and attempt < maxRetries', async () => {
    const err = new HarnessError('net fail', HarnessErrorCode.ADAPTER_NETWORK);
    const handler = makeHandler(
      [
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: err },
      ],
      {
        ok: false,
        error: err,
        errorCategory: HarnessErrorCode.ADAPTER_NETWORK,
      },
    );
    const policy = makePolicy({ maxRetries: 3 });
    const gen = runStreamingAttempt({
      streamHandler: handler,
      policy,
      conversation: CONV,
      cumulativeStreamBytesSoFar: 0,
      attempt: 0,
    });
    const seen: AgentEvent[] = [];
    let outcome: StreamingAttemptOutcome | undefined;
    while (true) {
      const step = await gen.next();
      if (step.done) {
        outcome = step.value;
        break;
      }
      seen.push(step.value);
    }
    // Retry path: buffered error must be swallowed, so consumer only sees the
    // partial text delta, never the error event.
    expect(seen.map((e) => e.type)).toEqual(['text_delta']);
    expect(outcome).toEqual({
      kind: 'retry',
      errorCategory: HarnessErrorCode.ADAPTER_NETWORK,
    });
    // Retry path must NOT record failure — that's for terminal only.
    expect(policy.failures).toBe(0);
    expect(policy.successes).toBe(0);
  });

  it('swallows error event across every in-flight retry attempt', async () => {
    // 3 separate attempts, each returns a retryable error: the helper is
    // called once per attempt, so each yields an error that is swallowed.
    const err = new HarnessError('net fail', HarnessErrorCode.ADAPTER_NETWORK);
    const seenAll: AgentEvent[] = [];
    for (const attempt of [0, 1, 2]) {
      const handler = makeHandler(
        [{ type: 'error', error: err }],
        { ok: false, error: err, errorCategory: HarnessErrorCode.ADAPTER_NETWORK },
      );
      const policy = makePolicy({ maxRetries: 3 });
      const gen = runStreamingAttempt({
        streamHandler: handler,
        policy,
        conversation: CONV,
        cumulativeStreamBytesSoFar: 0,
        attempt,
      });
      while (true) {
        const step = await gen.next();
        if (step.done) break;
        seenAll.push(step.value);
      }
    }
    expect(seenAll).toHaveLength(0);
  });
});

describe('runStreamingAttempt — terminal-failure path', () => {
  it('forwards buffered error event verbatim then returns terminal-failure', async () => {
    const err = new HarnessError('auth fail', HarnessErrorCode.ADAPTER_AUTH);
    const errorEvent: AgentEvent = { type: 'error', error: err };
    const handler = makeHandler(
      [{ type: 'text_delta', text: 'hi' }, errorEvent],
      {
        ok: false,
        error: err,
        errorCategory: HarnessErrorCode.ADAPTER_AUTH,
      },
    );
    const policy = makePolicy({ maxRetries: 3 });
    const gen = runStreamingAttempt({
      streamHandler: handler,
      policy,
      conversation: CONV,
      cumulativeStreamBytesSoFar: 0,
      attempt: 0,
    });
    const seen: AgentEvent[] = [];
    let outcome: StreamingAttemptOutcome | undefined;
    while (true) {
      const step = await gen.next();
      if (step.done) {
        outcome = step.value;
        break;
      }
      seen.push(step.value);
    }
    expect(seen.map((e) => e.type)).toEqual(['text_delta', 'error']);
    // Terminal-failure MUST preserve the same error instance (buffered, not re-wrapped).
    expect((seen[1] as Extract<AgentEvent, { type: 'error' }>).error).toBe(err);
    expect(outcome).toEqual({
      kind: 'terminal-failure',
      error: err,
      errorCategory: HarnessErrorCode.ADAPTER_AUTH,
    });
    expect(policy.failures).toBe(1);
    expect(policy.successes).toBe(0);
  });

  it('terminal when error is non-retryable even at attempt 0', async () => {
    const err = new HarnessError('auth fail', HarnessErrorCode.ADAPTER_AUTH);
    const handler = makeHandler(
      [{ type: 'error', error: err }],
      { ok: false, error: err, errorCategory: HarnessErrorCode.ADAPTER_AUTH },
    );
    // Only NETWORK is retryable; AUTH is not.
    const policy = makePolicy({
      maxRetries: 10,
      retryable: (c) => c === HarnessErrorCode.ADAPTER_NETWORK,
    });
    const gen = runStreamingAttempt({
      streamHandler: handler,
      policy,
      conversation: CONV,
      cumulativeStreamBytesSoFar: 0,
      attempt: 0,
    });
    let outcome: StreamingAttemptOutcome | undefined;
    while (true) {
      const step = await gen.next();
      if (step.done) {
        outcome = step.value;
        break;
      }
    }
    expect(outcome?.kind).toBe('terminal-failure');
    expect(policy.failures).toBe(1);
  });

  it('terminal when retryable error exceeds maxRetries', async () => {
    const err = new HarnessError('net fail', HarnessErrorCode.ADAPTER_NETWORK);
    const handler = makeHandler(
      [{ type: 'error', error: err }],
      { ok: false, error: err, errorCategory: HarnessErrorCode.ADAPTER_NETWORK },
    );
    const policy = makePolicy({ maxRetries: 3 });
    const gen = runStreamingAttempt({
      streamHandler: handler,
      policy,
      conversation: CONV,
      cumulativeStreamBytesSoFar: 0,
      attempt: 3, // equal to maxRetries → terminal, not retry
    });
    const seen: AgentEvent[] = [];
    let outcome: StreamingAttemptOutcome | undefined;
    while (true) {
      const step = await gen.next();
      if (step.done) {
        outcome = step.value;
        break;
      }
      seen.push(step.value);
    }
    // Buffered error is now emitted because attempt ≥ maxRetries.
    expect(seen.map((e) => e.type)).toEqual(['error']);
    expect(outcome?.kind).toBe('terminal-failure');
    expect(policy.failures).toBe(1);
  });
});

describe('runStreamingAttempt — iterator close propagation', () => {
  it("forwards consumer .return() into StreamHandler's finally block", async () => {
    const onReturn = vi.fn();
    // An infinite-ish handler so we can demonstrate .return() causes
    // iterator close rather than waiting for natural end-of-stream.
    const handler: StreamHandler = {
      async *handle(): AsyncGenerator<AgentEvent, StreamResult> {
        try {
          for (let i = 0; i < 1000; i++) {
            yield { type: 'text_delta', text: `chunk-${i}` };
          }
          return {
            ok: true,
            message: MSG,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            bytesRead: 0,
          };
        } finally {
          onReturn();
        }
      },
    };
    const policy = makePolicy();
    const gen = runStreamingAttempt({
      streamHandler: handler,
      policy,
      conversation: CONV,
      cumulativeStreamBytesSoFar: 0,
      attempt: 0,
    });
    // Consume two events then abort by calling .return() on the outer gen.
    await gen.next();
    await gen.next();
    await gen.return(undefined);
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it('tolerates StreamHandler whose .return() throws asynchronously', async () => {
    const handler: StreamHandler = {
      handle(): AsyncGenerator<AgentEvent, StreamResult> {
        // Return an iterator-shaped object whose .return() rejects. The
        // helper's finally block catches this so the outer test must not
        // observe a rejection.
        return {
          async next(): Promise<IteratorResult<AgentEvent, StreamResult>> {
            return {
              done: false,
              value: { type: 'text_delta', text: 'a' },
            };
          },
          async return(): Promise<IteratorResult<AgentEvent, StreamResult>> {
            throw new Error('return() boom');
          },
          async throw(err: unknown): Promise<IteratorResult<AgentEvent, StreamResult>> {
            throw err;
          },
          [Symbol.asyncIterator](): AsyncGenerator<AgentEvent, StreamResult> {
            return this as unknown as AsyncGenerator<AgentEvent, StreamResult>;
          },
        } as unknown as AsyncGenerator<AgentEvent, StreamResult>;
      },
    };
    const policy = makePolicy();
    const gen = runStreamingAttempt({
      streamHandler: handler,
      policy,
      conversation: CONV,
      cumulativeStreamBytesSoFar: 0,
      attempt: 0,
    });
    await gen.next();
    // Must not throw: .return() swallowing is the documented contract.
    await expect(gen.return(undefined)).resolves.toBeDefined();
  });
});

describe('runStreamingAttempt — event ordering invariant', () => {
  it('never yields the error event before the terminal return (retry path)', async () => {
    const err = new HarnessError('x', HarnessErrorCode.ADAPTER_NETWORK);
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'partial' },
      { type: 'error', error: err },
    ];
    const handler = makeHandler(events, {
      ok: false,
      error: err,
      errorCategory: HarnessErrorCode.ADAPTER_NETWORK,
    });
    const policy = makePolicy();
    const gen = runStreamingAttempt({
      streamHandler: handler,
      policy,
      conversation: CONV,
      cumulativeStreamBytesSoFar: 0,
      attempt: 0,
    });
    const seen: AgentEvent[] = [];
    let done = false;
    while (!done) {
      const step = await gen.next();
      if (step.done) {
        done = true;
      } else {
        seen.push(step.value);
      }
    }
    // Retry: error must be swallowed, so no 'error' in visible stream.
    expect(seen.some((e) => e.type === 'error')).toBe(false);
  });

  it("forwards the error event only after policy decides it's terminal", async () => {
    const err = new HarnessError('x', HarnessErrorCode.ADAPTER_AUTH);
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'partial' },
      { type: 'error', error: err },
    ];
    const handler = makeHandler(events, {
      ok: false,
      error: err,
      errorCategory: HarnessErrorCode.ADAPTER_AUTH,
    });
    const policy = makePolicy({ retryable: () => false });
    const gen = runStreamingAttempt({
      streamHandler: handler,
      policy,
      conversation: CONV,
      cumulativeStreamBytesSoFar: 0,
      attempt: 0,
    });
    const seen: AgentEvent[] = [];
    let done = false;
    while (!done) {
      const step = await gen.next();
      if (step.done) {
        done = true;
      } else {
        seen.push(step.value);
      }
    }
    // Terminal: error is now visible; it trails the text_delta.
    expect(seen.map((e) => e.type)).toEqual(['text_delta', 'error']);
  });
});
