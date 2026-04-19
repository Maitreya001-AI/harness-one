/**
 * Agent event types — discriminated union for all events yielded by AgentLoop.
 *
 * @module
 */

import type { Message, TokenUsage, ToolCallRequest } from './types.js';
import { HarnessError, HarnessErrorCode} from './errors.js';

/** Reason the agent loop terminated. */
export type DoneReason = 'end_turn' | 'max_iterations' | 'token_budget' | 'aborted' | 'error';

/**
 * Discriminated union of all events yielded by the AgentLoop.
 *
 * @example
 * ```ts
 * for await (const event of loop.run(messages)) {
 *   if (event.type === 'message') console.log(event.message.content);
 * }
 * ```
 */
export type AgentEvent =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; toolCall: Partial<ToolCallRequest> }
  | { type: 'tool_call'; toolCall: ToolCallRequest; iteration: number }
  | { type: 'tool_result'; toolCallId: string; result: unknown }
  | { type: 'message'; message: Message; usage: TokenUsage }
  | { type: 'warning'; message: string }
  | { type: 'error'; error: HarnessError | Error }
  // Emitted when a GuardrailPipeline returns a `block` verdict
  // during one of AgentLoop's three fixed hook points. Consumers can observe
  // this before the follow-up `error`/`done` pair (for input/output blocks)
  // or in isolation (for tool_output blocks, which rewrite the tool result
  // and let the loop continue).
  | { type: 'guardrail_blocked'; phase: 'input' | 'tool_output' | 'output'; guardName: string; details?: unknown }
  | { type: 'done'; reason: DoneReason; totalUsage: TokenUsage };

/**
 * Exhaustive check helper for discriminated unions.
 *
 * Use in the `default` case of a switch statement to ensure all variants
 * are handled at compile time. Throws at runtime if an unexpected value
 * reaches this point, indicating a bug.
 *
 * @example
 * ```ts
 * function handleEvent(event: AgentEvent) {
 *   switch (event.type) {
 *     case 'message': return;
 *     // ... all other cases ...
 *     default: assertNever(event.type);
 *   }
 * }
 * ```
 */
export function assertNever(_x: never): never {
  // Do NOT interpolate the value into the message — if the discriminant ever
  // carries user-derived content, the unreachable-branch error would leak it
  // into logs/traces. `CORE_UNEXPECTED_VALUE` + the caller's stack is enough
  // to pinpoint the bug.
  throw new HarnessError(
    'Unexpected discriminant in exhaustive switch',
    HarnessErrorCode.CORE_UNEXPECTED_VALUE,
    'This is a bug in harness-one — a new union variant was added without updating the switch.',
  );
}
