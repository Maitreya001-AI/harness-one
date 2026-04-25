/**
 * Guardrail runner — wraps {@link GuardrailPipeline} invocation for the three
 * phases the iteration-runner cares about (input, output, tool_output) and
 * returns the events + follow-up action in a discriminated union the runner
 * can mechanically dispatch.
 *
 * Extracted from `iteration-runner.ts` in round-3 cleanup. The previous inline
 * invocations at lines ~336, ~505, ~638 scattered three near-identical event
 * constructions across the runner body; each one built a `guardrail_blocked`
 * event and a matching `HarnessError`, then routed to `bailOut` (input/output)
 * or rewrote the tool result in place (tool_output). This module centralises
 * those shapes so new phases or error taxonomies change in one place.
 *
 * Pure dispatcher — yields no events itself. The caller is responsible for
 * yielding the returned events in the order it needs them so the runner's
 * overall event sequence stays under a single reviewer's eye.
 *
 * @module
 */

import type { AgentEvent } from './events.js';
import { HarnessError, HarnessErrorCode } from './errors.js';
import type { GuardrailPipeline } from './guardrail-port.js';
import { findLatestUserMessage, pickBlockingGuardName } from './guardrail-helpers.js';
import type { Message } from './types.js';

/**
 * Outcome returned by {@link runInputGuardrail} / {@link runOutputGuardrail}.
 *
 * - `passed` — guardrail allowed the payload; the runner should continue.
 * - `blocked` — guardrail issued a `block` verdict; the runner should yield
 *   `guardrailEvent` followed by `errorEvent`, abort upstream, and bail.
 */
export type TextGuardrailOutcome =
  | { readonly kind: 'passed' }
  | {
      readonly kind: 'blocked';
      readonly guardrailEvent: Extract<AgentEvent, { type: 'guardrail_blocked' }>;
      readonly errorEvent: Extract<AgentEvent, { type: 'error' }>;
    };

/**
 * Outcome returned by {@link runToolOutputGuardrail}. Unlike the input/output
 * phases, a blocked tool-output does NOT abort the loop — the runner rewrites
 * the tool result into a stub and keeps going. The `replacementContent` is
 * pre-serialised so the runner can drop it directly into the tool message.
 */
export type ToolGuardrailOutcome =
  | { readonly kind: 'passed' }
  | {
      readonly kind: 'blocked';
      readonly guardrailEvent: Extract<AgentEvent, { type: 'guardrail_blocked' }>;
      readonly replacementContent: string;
    };

/**
 * Run the input pipeline against the latest user message.
 *
 * Returns `{ kind: 'passed' }` when the pipeline is absent, when the
 * conversation has no user message, or when no guard issues a `block`
 * verdict — the runner proceeds to the adapter call in all three cases.
 */
export async function runInputGuardrail(
  conversation: readonly Message[],
  pipeline: GuardrailPipeline | undefined,
): Promise<TextGuardrailOutcome> {
  if (!pipeline) return { kind: 'passed' };
  const latestUser = findLatestUserMessage(conversation);
  if (latestUser === undefined) return { kind: 'passed' };

  const result = await pipeline.runInput({ content: latestUser });
  if (result.passed || result.verdict.action !== 'block') return { kind: 'passed' };

  const guardName = pickBlockingGuardName(result, 'input');
  const reason = result.verdict.reason;
  return {
    kind: 'blocked',
    guardrailEvent: {
      type: 'guardrail_blocked',
      phase: 'input',
      guardName,
      details: { reason },
    },
    errorEvent: {
      type: 'error',
      error: new HarnessError(
        `guardrail "${guardName}" blocked input — ${reason}`,
        HarnessErrorCode.GUARD_VIOLATION,
        'Review the input pipeline configuration and sanitize the user message',
      ),
    },
  };
}

/**
 * Run the input pipeline against a tool call's serialised arguments.
 *
 * Called once per tool_call BEFORE the runner yields the `tool_call` event
 * and BEFORE any tool side-effect runs. Closes the asymmetry where direct
 * `createAgentLoop` users with an input pipeline previously got
 * user-message validation but not tool-arg validation. Preset users are
 * unaffected because the preset does not pass `inputPipeline` to the inner
 * AgentLoop (it manages all guardrail phases at the `harness.run()`
 * boundary instead).
 *
 * Returns `{ kind: 'passed' }` when the pipeline is absent — the runner
 * proceeds to yield the `tool_call` event. A `block` verdict mirrors
 * `runInputGuardrail`: emit `guardrail_blocked` (phase `'tool_args'`) +
 * `error` (`HarnessErrorCode.GUARD_VIOLATION`), abort upstream, bail the
 * iteration. The `tool_call` event is NOT yielded — consumers never see
 * a tool_call that was blocked by its own arguments.
 *
 * Note on rate-limit-style guardrails: this check counts as one
 * additional pipeline run per tool_call. If `inputPipeline` includes a
 * rate-limiter, the limiter will see N+M increments per iteration where
 * N is user-message increments (today) and M is tool-call count. Lift
 * the rate-limiter out of `inputPipeline` (or use a wrapping retry/
 * backoff layer) if this is undesirable.
 */
export async function runToolArgsGuardrail(
  argContent: string,
  toolName: string | undefined,
  toolCallId: string,
  pipeline: GuardrailPipeline | undefined,
): Promise<TextGuardrailOutcome> {
  if (!pipeline) return { kind: 'passed' };

  const result = await pipeline.runInput({ content: argContent });
  if (result.passed || result.verdict.action !== 'block') return { kind: 'passed' };

  const guardName = pickBlockingGuardName(result, 'input');
  const reason = result.verdict.reason;
  return {
    kind: 'blocked',
    guardrailEvent: {
      type: 'guardrail_blocked',
      phase: 'tool_args',
      guardName,
      details: {
        toolCallId,
        ...(toolName !== undefined ? { toolName } : {}),
        reason,
      },
    },
    errorEvent: {
      type: 'error',
      error: new HarnessError(
        `guardrail "${guardName}" blocked tool arguments — ${reason}`,
        HarnessErrorCode.GUARD_VIOLATION,
        'Review the input pipeline and the tool-call arguments emitted by the model',
      ),
    },
  };
}

/**
 * Run the output pipeline against the model's final (no-tool-calls) response
 * content. Same `passed` / `blocked` semantics as {@link runInputGuardrail}.
 */
export async function runOutputGuardrail(
  finalContent: string,
  pipeline: GuardrailPipeline | undefined,
): Promise<TextGuardrailOutcome> {
  if (!pipeline) return { kind: 'passed' };

  const result = await pipeline.runOutput({ content: finalContent });
  if (result.passed || result.verdict.action !== 'block') return { kind: 'passed' };

  const guardName = pickBlockingGuardName(result, 'output');
  const reason = result.verdict.reason;
  return {
    kind: 'blocked',
    guardrailEvent: {
      type: 'guardrail_blocked',
      phase: 'output',
      guardName,
      details: { reason },
    },
    errorEvent: {
      type: 'error',
      error: new HarnessError(
        `guardrail "${guardName}" blocked output — ${reason}`,
        HarnessErrorCode.GUARD_VIOLATION,
        'Review the output pipeline configuration and the model response',
      ),
    },
  };
}

/**
 * Run the output pipeline against a tool result. Unlike the other two phases,
 * a `block` verdict rewrites the tool result into a JSON stub; the runner
 * does NOT abort.
 */
export async function runToolOutputGuardrail(
  resultContent: string,
  toolName: string | undefined,
  toolCallId: string,
  pipeline: GuardrailPipeline | undefined,
): Promise<ToolGuardrailOutcome> {
  if (!pipeline) return { kind: 'passed' };

  const result = await pipeline.runToolOutput(resultContent, toolName);
  if (result.passed || result.verdict.action !== 'block') return { kind: 'passed' };

  const guardName = pickBlockingGuardName(result, 'output');
  const reason = result.verdict.reason;
  return {
    kind: 'blocked',
    guardrailEvent: {
      type: 'guardrail_blocked',
      phase: 'tool_output',
      guardName,
      details: {
        toolCallId,
        ...(toolName !== undefined ? { toolName } : {}),
        reason,
      },
    },
    replacementContent: JSON.stringify({
      error: `${HarnessErrorCode.GUARD_VIOLATION}: ${guardName}`,
      reason,
    }),
  };
}
