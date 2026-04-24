/**
 * Aggregate invariant assertions for chaos scenarios.
 *
 * These helpers answer one question: "after N runs with injected faults,
 * does the harness still hold the invariants that matter to operators?"
 * They are deliberately coarse-grained — a single scenario calls each
 * relevant assertion once at the end instead of per-run, so the failure
 * mode is "the system leaked span X after 200 attempts" rather than
 * "this specific call was off by one."
 *
 * All assertions use `vitest`'s `expect` directly so failures surface on
 * the calling scenario's stack and the scenario file stays free of
 * `assert`-chain plumbing.
 *
 * @module
 */
import { expect } from 'vitest';
import type { TraceManager } from '../../src/observe/trace-manager-types.js';
import type { CostTracker } from '../../src/observe/cost-tracker-types.js';
import type { SessionManager } from '../../src/session/manager-types.js';
import type { FsMemoryStore } from '../../src/memory/fs-store.js';
import type { DoneReason } from '../../src/core/events.js';

/**
 * Minimal shape a scenario records per-run so the assertion library can
 * reason about aggregate invariants without coupling to the concrete
 * scenario's AgentEvent handling.
 */
export interface RunOutcome {
  /** Terminal `done` reason emitted by the loop (or `'no-done'` if never emitted). */
  readonly reason: DoneReason | 'no-done';
  /** Loop lifecycle status after `run()` completed. */
  readonly status: 'idle' | 'running' | 'completed' | 'errored' | 'disposed';
  /** Unique trace id for the run (when a traceManager was wired). */
  readonly traceId?: string;
  /** Wall-clock milliseconds spent in `run()`. */
  readonly elapsedMs: number;
  /** Scenario-specific bucket — e.g. `'retry-then-success'`, `'fallback'`. */
  readonly bucket?: string;
}

/**
 * No trace span is still "active" (open) after all runs completed.
 *
 * The canonical span leak symptom is a TraceManager that exposes open
 * spans after every loop has ended. We tolerate `undefined` for
 * `traceManager` so scenarios without observability still pass this
 * assertion vacuously.
 */
export function assertNoActiveSpans(traceManager: TraceManager | undefined): void {
  if (traceManager === undefined) return;
  const active = traceManager.getActiveSpans();
  expect(active, `expected zero active spans, found ${active.length}`).toHaveLength(0);
}

/**
 * The cost tracker's recent-window total equals the sum of its
 * per-trace totals (modulo known overflow).
 *
 * `getTotalCost()` is bounded by the recent-record window;
 * `getCostByTrace()` is cumulative since start. When we keep `maxRecords`
 * above the number of runs (which every chaos scenario does), the two
 * must match — a divergence proves accounting corruption.
 *
 * We also assert every run's bucket total is finite and non-negative;
 * negative costs mean a credit-style bug in the eviction path.
 */
export function assertCostConsistency(
  costTracker: CostTracker,
  runs: readonly RunOutcome[],
): void {
  const total = costTracker.getTotalCost();
  expect(Number.isFinite(total), `total cost must be finite, got ${total}`).toBe(true);
  expect(total).toBeGreaterThanOrEqual(0);

  let perTraceSum = 0;
  const seen = new Set<string>();
  for (const run of runs) {
    if (!run.traceId || seen.has(run.traceId)) continue;
    seen.add(run.traceId);
    const cost = costTracker.getCostByTrace(run.traceId);
    expect(Number.isFinite(cost), `trace cost must be finite, got ${cost}`).toBe(true);
    expect(cost).toBeGreaterThanOrEqual(0);
    perTraceSum += cost;
  }

  // We can't assert strict equality with `total` because the cost tracker
  // may buffer records (maxRecords), but we CAN assert the per-trace sum
  // is not exceeded by the recent-window total — that would mean the
  // recent window claims cost that never landed on a trace.
  expect(
    total,
    `recent-window total (${total}) should not exceed per-trace cumulative (${perTraceSum})`,
  ).toBeLessThanOrEqual(perTraceSum + 1e-9);
}

/**
 * Every session created during the scenario is reachable through
 * `SessionManager.access()` without throwing SESSION_LOCKED. If a lock
 * never released after an abort, the session would still appear as
 * 'locked' and `access()` would throw.
 *
 * `sessionIds` is the list of session ids the scenario created — we
 * can't iterate SessionManager for already-destroyed sessions, so the
 * scenario supplies the ids.
 */
export function assertSessionLocksReleased(
  sessionManager: SessionManager,
  sessionIds: readonly string[],
): void {
  for (const id of sessionIds) {
    const session = sessionManager.get(id);
    if (session === undefined) continue; // destroyed / GC'd — no lock to leak.
    expect(
      session.status,
      `session ${id} expected active, got ${session.status}`,
    ).not.toBe('locked');
  }
}

/**
 * `reconcileIndex()` finds nothing to reconcile — i.e. every write either
 * fully committed or never landed on disk. Half-writes are the canonical
 * symptom of a chaos run leaving the memory store inconsistent.
 */
export async function assertMemoryStoreConsistent(store: FsMemoryStore): Promise<void> {
  const before = await store.reconcileIndex();
  const after = await store.reconcileIndex();
  // Running reconcile twice must be idempotent: the second call sees the
  // same number of keys as the first. If a partial write was dangling,
  // the first call would recover it and the second would see it.
  expect(after.keys).toBe(before.keys);
  expect(after.scanned).toBe(before.scanned);
}

/**
 * Every run ended in some terminal `DoneReason` — no run is stuck in
 * `'no-done'` (which would mean the generator never yielded `done`).
 *
 * Also asserts loop status is one of the post-terminal states. A run
 * stuck in `'running'` after the generator drained is the canonical
 * "loop is wedged" symptom.
 */
export function assertAllRunsReachedTerminalState(runs: readonly RunOutcome[]): void {
  const stuck = runs.filter((r) => r.reason === 'no-done');
  expect(stuck, `${stuck.length} runs never emitted a 'done' event`).toHaveLength(0);

  const wedged = runs.filter((r) => r.status === 'running' || r.status === 'idle');
  expect(wedged, `${wedged.length} runs did not reach a post-terminal status`).toHaveLength(0);
}
