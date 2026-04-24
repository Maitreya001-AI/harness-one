/**
 * N1 · AgentEvent exhaustive check.
 *
 * The AgentEvent discriminated union is the public contract for
 * `AgentLoop.run()` consumers. Adding a new variant is a minor breaking
 * change — every downstream switch over `event.type` must grow a case.
 *
 * Two locks:
 *
 * 1. `assertNever` in the default branch of a full switch — if a new
 *    variant is added without a case, `tsc` refuses to compile this file.
 * 2. An `expectTypeOf` equality against an inline enumeration of the
 *    discriminants — catches refactors that rename an existing variant
 *    even if every case is still "covered".
 *
 * When this file fails to compile, the fix is in the test: update the
 * switch / discriminant list AND the PR description (the signature
 * change is user-observable).
 */
import { expectTypeOf } from 'expect-type';
import type { AgentEvent, DoneReason } from 'harness-one/core';
import { assertNever } from 'harness-one/core';

// ── 1. Exhaustive switch ──────────────────────────────────────────────────
declare function handle(event: AgentEvent): string;
handle satisfies (event: AgentEvent) => string;

function _exhaustive(event: AgentEvent): string {
  switch (event.type) {
    case 'iteration_start':
      return `iter_${event.iteration}`;
    case 'text_delta':
      return event.text;
    case 'tool_call_delta':
      return JSON.stringify(event.toolCall);
    case 'tool_call':
      return `${event.toolCall.name}#${event.iteration}`;
    case 'tool_result':
      return event.toolCallId;
    case 'message':
      return `${event.message.role}:${event.message.content}`;
    case 'warning':
      return event.message;
    case 'error':
      return event.error.message;
    case 'guardrail_blocked':
      return `${event.phase}:${event.guardName}`;
    case 'done':
      return event.reason;
    default:
      // If a new variant is added without a case above, `event` is no longer
      // `never` and this line fails to compile with:
      //   "Argument of type 'X' is not assignable to parameter of type 'never'."
      return assertNever(event);
  }
}

// ── 2. Discriminant set lock ──────────────────────────────────────────────
// Extract the `type` discriminant from every variant; compare against an
// explicit enumeration. If a variant is renamed or dropped, the equality
// fails — catches cases that a dropped switch branch would silently miss.
type AgentEventType = AgentEvent['type'];
type ExpectedAgentEventTypes =
  | 'iteration_start'
  | 'text_delta'
  | 'tool_call_delta'
  | 'tool_call'
  | 'tool_result'
  | 'message'
  | 'warning'
  | 'error'
  | 'guardrail_blocked'
  | 'done';

expectTypeOf<AgentEventType>().toEqualTypeOf<ExpectedAgentEventTypes>();

// ── 3. Done reasons locked ────────────────────────────────────────────────
// `done.reason` drives post-run disposition branches. Locking the string
// literal set keeps consumers from silently losing a terminal case.
expectTypeOf<DoneReason>().toEqualTypeOf<
  'end_turn' | 'max_iterations' | 'token_budget' | 'aborted' | 'error'
>();
