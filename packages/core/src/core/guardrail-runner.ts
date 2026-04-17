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
