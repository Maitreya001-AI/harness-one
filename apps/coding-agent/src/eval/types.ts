/**
 * Public types for the coding-agent evaluation harness.
 *
 * The harness lets us run a fixture set against `createCodingAgent` and
 * report pass/fail per fixture — the foundation for SWE-bench-style
 * benchmarks. The fixture format is intentionally compact: a workspace
 * template (a map of relative paths to file content), the user prompt,
 * a budget, and a verifier function that inspects the post-run workspace.
 *
 * @module
 */

import type { TaskResult } from '../agent/types.js';
import type { BudgetLimits } from '../agent/types.js';

/** A single evaluation case. */
export interface EvalFixture {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Initial workspace contents — relative path → utf8 content. */
  readonly workspace: Readonly<Record<string, string>>;
  /** Prompt the agent should be run with. */
  readonly prompt: string;
  /** Optional per-fixture budget override. */
  readonly budget?: Partial<BudgetLimits>;
  /**
   * Tags so the runner can filter — e.g. `['fix-test']`, `['rename']`,
   * `['swebench-lite']`.
   */
  readonly tags?: readonly string[];
  /**
   * Verifier function. Called after the agent run with the workspace
   * directory and the `TaskResult`. Returns the verdict.
   *
   * Implementers should read files via `fs.promises` and assert against
   * expected content. Throwing or returning `{ pass: false }` both fail
   * the fixture.
   */
  readonly verify: (ctx: VerifierContext) => Promise<VerifierVerdict>;
}

export interface VerifierContext {
  readonly workspace: string;
  readonly result: TaskResult;
}

export interface VerifierVerdict {
  readonly pass: boolean;
  readonly reason?: string;
  /** Free-form details surfaced in the report. */
  readonly details?: Record<string, unknown>;
}

/** Outcome of running a single fixture. */
export interface EvalCaseResult {
  readonly fixtureId: string;
  readonly pass: boolean;
  readonly reason?: string;
  readonly result: TaskResult;
  readonly details?: Record<string, unknown>;
  readonly durationMs: number;
}

/** Aggregate of one full eval run. */
export interface EvalRunResult {
  readonly cases: readonly EvalCaseResult[];
  readonly passCount: number;
  readonly failCount: number;
  readonly passRate: number;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
}
