/**
 * State machine for a single coding-agent task.
 *
 * Encodes the legal transitions described in
 * [`docs/coding-agent-DESIGN.md`](../../../../docs/coding-agent-DESIGN.md)
 * §3.4. Illegal transitions throw `HarnessError`(`CORE_INVALID_STATE`) so
 * bugs surface loud rather than silently corrupting checkpoint state.
 *
 * The state machine is a pure value — no I/O, no side-effects. The
 * `loop.ts` orchestrator owns persistence (checkpoint writes) and adapter
 * calls; this module only adjudicates which transitions are legal.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';

import type { TaskState } from './types.js';

/**
 * Adjacency table — every legal forward transition. `aborted` is reachable
 * from any non-terminal state and is therefore handled separately in
 * {@link assertTransition} rather than enumerated here.
 */
const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  planning: ['executing'],
  executing: ['executing', 'testing'],
  testing: ['executing', 'reviewing'],
  reviewing: ['done'],
  done: [],
  aborted: [],
});

/** Terminal states — `done` (success) and `aborted` (graceful abort/error). */
const TERMINAL: ReadonlySet<TaskState> = new Set(['done', 'aborted']);

/** All non-terminal states can transition to `aborted`. */
function canAbort(from: TaskState): boolean {
  return !TERMINAL.has(from);
}

/**
 * Return `true` iff `from → to` is a legal transition.
 *
 * `executing → executing` and `testing → executing` are both legal so the
 * `executing → testing → executing` retry loop in DESIGN §3.4 can compose
 * cleanly. Self-loops in any other state are rejected — they would mask
 * a bug where the orchestrator fails to advance after work is complete.
 */
export function isLegalTransition(from: TaskState, to: TaskState): boolean {
  if (from === to && from !== 'executing') return false;
  if (to === 'aborted') return canAbort(from);
  return TRANSITIONS[from].includes(to);
}

/**
 * Throw if `from → to` is not a legal transition.
 *
 * Use at every state-write site so an out-of-order coordinator bug surfaces
 * with a clear error instead of corrupting downstream checkpoints.
 */
export function assertTransition(from: TaskState, to: TaskState): void {
  if (!isLegalTransition(from, to)) {
    throw new HarnessError(
      `Illegal task-state transition: ${from} → ${to}`,
      HarnessErrorCode.CORE_INVALID_STATE,
      'Caller attempted a transition not allowed by the coding-agent state machine. ' +
        'See `docs/coding-agent-DESIGN.md` §3.4 for the legal graph.',
    );
  }
}

/** True when `state` is `done` or `aborted`. */
export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

/** Legal next states from `from`, including the abort path. */
export function nextStates(from: TaskState): readonly TaskState[] {
  if (isTerminal(from)) return [];
  return [...TRANSITIONS[from], 'aborted'] as const;
}
