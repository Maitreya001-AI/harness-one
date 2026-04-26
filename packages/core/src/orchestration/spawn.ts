/**
 * Spawn a sub-agent loop, run it to completion, and return the result.
 *
 * @module
 */

import { AgentLoop } from '../core/agent-loop.js';
import type { AgentLoopConfig } from '../core/agent-loop.js';
import type { Message } from '../core/types.js';
import type { DoneReason } from '../core/events.js';
import { HarnessError, HarnessErrorCode } from '../core/errors.js';
import type { SpawnSubAgentConfig, SpawnSubAgentResult } from './types.js';

/**
 * Spawn a child {@link AgentLoop}, run it to completion, and return the
 * accumulated conversation, token usage, and termination reason.
 *
 * **Failure contract** — this function follows Promise semantics: terminal
 * states that represent an *unhandled* failure surface as a thrown
 * {@link HarnessError}. Soft budget exhaustion is a *normal* outcome and
 * resolves with `doneReason` set so the caller can inspect partial work.
 *
 * | `doneReason`         | Behaviour |
 * |----------------------|-----------|
 * | `end_turn`           | resolves with the result |
 * | `max_iterations`     | resolves with the result (caller-set budget) |
 * | `token_budget`       | resolves with the result (caller-set budget) |
 * | `duration_budget`    | resolves with the result (caller-set budget) |
 * | `guardrail_blocked`  | resolves with the result (policy decision) |
 * | `aborted`            | **throws** {@link HarnessErrorCode.CORE_ABORTED} |
 * | `error`              | **throws** {@link HarnessErrorCode.ADAPTER_ERROR} with `cause` |
 *
 * The previous implementation resolved on every terminal state including
 * `error` and `aborted`, leaving callers that wrapped this in `try/catch`
 * silently fooled into believing the run succeeded. See FRICTION_LOG
 * `04-orchestration-handoff: spawnSubAgent swallows errors`.
 *
 * **Streaming limitation**: child agent streaming output is consumed
 * internally. To receive real-time updates from child agents, use the
 * event callback mechanism via `onEvent` instead of direct stream
 * passthrough.
 */
export async function spawnSubAgent(config: SpawnSubAgentConfig): Promise<SpawnSubAgentResult> {
  const loopConfig: AgentLoopConfig = {
    adapter: config.adapter,
    maxIterations: config.maxIterations ?? 10,
    ...(config.maxTotalTokens !== undefined && { maxTotalTokens: config.maxTotalTokens }),
    ...(config.signal !== undefined && { signal: config.signal }),
    ...(config.tools && { tools: [...config.tools] }),
    ...(config.onToolCall !== undefined && { onToolCall: config.onToolCall }),
    ...(config.streaming !== undefined && { streaming: config.streaming }),
  };
  const loop = new AgentLoop(loopConfig);

  const conversation: Message[] = [...config.messages];
  let doneReason: DoneReason = 'end_turn';
  let capturedError: HarnessError | Error | undefined;

  try {
    for await (const event of loop.run([...config.messages])) {
      if (event.type === 'message') {
        conversation.push(event.message);
      } else if (event.type === 'tool_result') {
        conversation.push({
          role: 'tool' as const,
          content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
          toolCallId: event.toolCallId,
        });
      } else if (event.type === 'error') {
        // Stash the originating error so we can re-throw it as `cause`
        // when the loop ultimately reports `done: error`. Multiple error
        // events keep the *first* one — that's the one that cascaded the
        // termination. Subsequent events are usually teardown noise.
        if (capturedError === undefined) {
          capturedError = event.error;
        }
      } else if (event.type === 'done') {
        doneReason = event.reason;
      }
    }
  } finally {
    loop.dispose();
  }

  if (doneReason === 'error') {
    const cause = capturedError;
    throw new HarnessError(
      cause !== undefined
        ? `spawnSubAgent: sub-agent loop terminated with error: ${cause.message}`
        : 'spawnSubAgent: sub-agent loop terminated with error (no error event was captured)',
      HarnessErrorCode.ADAPTER_ERROR,
      'Inspect the `cause` for the originating exception; check the adapter wiring or downstream tool errors. ' +
        'If you need to handle this without throwing, wrap the call in try/catch.',
      cause,
    );
  }

  if (doneReason === 'aborted') {
    throw new HarnessError(
      'spawnSubAgent: sub-agent loop aborted',
      HarnessErrorCode.CORE_ABORTED,
      'The caller cancelled this run via AbortSignal. ' +
        'If you need to handle abort without throwing, wrap the call in try/catch and check error.code === HarnessErrorCode.CORE_ABORTED.',
      capturedError,
    );
  }

  return Object.freeze({
    messages: Object.freeze([...conversation]),
    usage: Object.freeze({ ...loop.usage }),
    doneReason,
  });
}
