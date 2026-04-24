/**
 * Shared helpers for chaos scenarios.
 *
 * Centralises the "collect the events, tally the outcome, record the
 * elapsed time" boilerplate so each scenario stays focused on the
 * invariants it cares about.
 *
 * @module
 */
import type { AgentEvent, DoneReason } from '../../src/core/events.js';
import type { RunOutcome } from './assertions.js';

/**
 * Consume an AgentLoop's event stream, returning the terminal outcome
 * plus a list of every event type observed (useful for tallying).
 */
export async function drainRun(
  gen: AsyncGenerator<AgentEvent>,
  opts?: { traceId?: string; bucket?: string },
): Promise<{ outcome: RunOutcome; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  let reason: DoneReason | 'no-done' = 'no-done';
  const start = Date.now();
  try {
    for await (const e of gen) {
      events.push(e);
      if (e.type === 'done') reason = e.reason;
    }
  } catch {
    // A thrown error in the generator counts as an 'error' terminal state —
    // the chaos adapter never throws from outside the loop's try boundary,
    // so any throw that reaches here is a harness bug. Record it as 'error'
    // and let the scenario-level assertions catch the missing 'done'.
    reason = 'error';
  }
  const elapsedMs = Date.now() - start;

  // Infer status: if the loop yielded `done`, it ended cleanly from its own
  // perspective — `completed` for end_turn, `errored` otherwise. If no done
  // was ever emitted we mark status 'errored' too; callers that want the
  // real AgentLoop.status should read it directly.
  const status: RunOutcome['status'] =
    reason === 'end_turn' ? 'completed'
    : reason === 'no-done' ? 'errored'
    : 'errored';

  const outcome: RunOutcome = {
    reason,
    status,
    elapsedMs,
    ...(opts?.traceId !== undefined ? { traceId: opts.traceId } : {}),
    ...(opts?.bucket !== undefined ? { bucket: opts.bucket } : {}),
  };
  return { outcome, events };
}

/**
 * Resolve the scenario seed. Priority:
 *   1. Explicit `override` argument (test-level per-seed reproducibility)
 *   2. `CHAOS_SEED` env var (CI / `for i in {1..10}; do CHAOS_SEED=$i ...`)
 *   3. Hard-coded fallback
 *
 * Every scenario MUST route fault-injection entropy through this helper so
 * reproducibility never depends on ad-hoc `Math.random`.
 */
export function resolveSeed(fallback: number, override?: number): number {
  if (override !== undefined) return override;
  const env = process.env.CHAOS_SEED;
  if (env !== undefined && env !== '') {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return fallback;
}
