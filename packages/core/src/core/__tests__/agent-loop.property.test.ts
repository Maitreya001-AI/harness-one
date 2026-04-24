/**
 * J1 · Property: AgentLoop status transition graph is valid under arbitrary
 * event sequences, and `disposed` is absorbing (once reached, nothing moves
 * the state back).
 *
 * The public AgentLoop only mutates status via `run()`/`dispose()` — the
 * event vocabulary ('start', 'step', 'tool_result', 'error', 'dispose') is
 * a coarse abstraction of what happens INSIDE `run()` plus the external
 * `dispose()` hatch. We model the transition function directly rather
 * than driving async generators, so the property suite exercises the
 * state rule in isolation from hook/adapter/iteration noise.
 *
 * The function below is a faithful translation of the rules in
 * `agent-loop.ts`:
 *   - idle → running (start)
 *   - running → running (step | tool_result)
 *   - running → errored (error, abort, max_iterations, guardrail_block)
 *   - any → disposed (dispose)
 *   - terminal (completed | errored | disposed) → same (no-op on further events)
 *
 * Ground-truth reference is the `AgentLoopStatus` union in `../types.ts`
 * and the `dispose()` guard in `../agent-loop.ts` that refuses to let a
 * terminal race un-dispose the loop.
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { AgentLoopStatus } from '../types.js';

type AbstractEvent = 'start' | 'step' | 'tool_result' | 'error' | 'dispose' | 'end_turn';

const VALID_STATUSES: readonly AgentLoopStatus[] = [
  'idle',
  'running',
  'completed',
  'errored',
  'disposed',
];

const TERMINAL_STATUSES: ReadonlySet<AgentLoopStatus> = new Set([
  'completed',
  'errored',
  'disposed',
]);

/**
 * Abstract status-transition function that mirrors the agent-loop rules.
 *
 * Returns the next status given current status and event. `disposed` is an
 * absorbing state; any other terminal is also absorbing in this abstract
 * model — a fresh run requires a fresh AgentLoop (re-entrancy is forbidden
 * by the real implementation).
 */
function nextStatus(status: AgentLoopStatus, event: AbstractEvent): AgentLoopStatus {
  if (status === 'disposed') return 'disposed';
  if (event === 'dispose') return 'disposed';
  if (status === 'completed' || status === 'errored') return status;
  if (status === 'idle') {
    if (event === 'start') return 'running';
    return 'idle';
  }
  // status === 'running'
  switch (event) {
    case 'start':
      return 'running';
    case 'step':
    case 'tool_result':
      return 'running';
    case 'end_turn':
      return 'completed';
    case 'error':
      return 'errored';
    default:
      return 'running';
  }
}

const eventArb = fc.oneof(
  fc.constantFrom<AbstractEvent>('start'),
  fc.constantFrom<AbstractEvent>('step'),
  fc.constantFrom<AbstractEvent>('tool_result'),
  fc.constantFrom<AbstractEvent>('error'),
  fc.constantFrom<AbstractEvent>('dispose'),
  fc.constantFrom<AbstractEvent>('end_turn'),
);

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

describe('J1 · AgentLoop state-machine (property)', () => {
  it('every reachable status is in the valid union', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 0, maxLength: 50 }), (events) => {
        let status: AgentLoopStatus = 'idle';
        for (const e of events) {
          status = nextStatus(status, e);
          expect(VALID_STATUSES).toContain(status);
        }
      }),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('once disposed, every subsequent event is a no-op', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 0, maxLength: 50 }), (events) => {
        let status: AgentLoopStatus = 'disposed';
        for (const e of events) {
          status = nextStatus(status, e);
          expect(status).toBe('disposed');
        }
      }),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('terminals never re-open — completed/errored/disposed only flow to same or disposed', () => {
    // Completed and errored are one-way terminals for the abstract loop;
    // the only outbound edge is `dispose` → disposed (an even stronger
    // terminal). No event can walk us back to 'idle' or 'running'.
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 50 }),
        fc.array(eventArb, { minLength: 0, maxLength: 50 }),
        (head, tail) => {
          let status: AgentLoopStatus = 'idle';
          for (const e of head) status = nextStatus(status, e);
          if (!TERMINAL_STATUSES.has(status)) return;
          const terminalEntered = status;
          for (const e of tail) {
            const prev = status;
            status = nextStatus(status, e);
            expect(TERMINAL_STATUSES.has(status)).toBe(true);
            if (prev === 'disposed') {
              expect(status).toBe('disposed');
            } else {
              expect([prev, 'disposed']).toContain(status);
            }
          }
          // And never revisit the initial terminal's non-disposed alternative.
          if (terminalEntered !== 'disposed') {
            expect([terminalEntered, 'disposed']).toContain(status);
          }
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('dispose event wins from any non-disposed status', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<AgentLoopStatus>('idle', 'running', 'completed', 'errored'),
        (start) => {
          expect(nextStatus(start, 'dispose')).toBe('disposed');
        },
      ),
      { numRuns: 100, ...(seed !== undefined && { seed }) },
    );
  });
});
