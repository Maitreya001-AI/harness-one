/**
 * Public types for the coding agent.
 *
 * Mirrors the data shapes called out in
 * [`docs/coding-agent-DESIGN.md`](../../../../docs/coding-agent-DESIGN.md)
 * §3.4 (state machine), §3.7 (checkpoint), §3.9 (budget), §4.1 (public API).
 *
 * @module
 */

import type { Message, ToolCallRequest } from 'harness-one/core';

// ── State machine ─────────────────────────────────────────────────────────

/**
 * Lifecycle states a coding-agent task moves through.
 *
 * The forward path is `planning → executing → testing → reviewing → done`.
 * `executing → testing` may loop back to `executing` on failed tests.
 * Any state may transition to `aborted` via `SIGINT`/budget/error paths.
 */
export type TaskState =
  | 'planning'
  | 'executing'
  | 'testing'
  | 'reviewing'
  | 'done'
  | 'aborted';

// ── Plan ──────────────────────────────────────────────────────────────────

/** A single decomposed step the agent intends to execute. */
export interface PlanStep {
  readonly id: string;
  readonly description: string;
  /** Tools the LLM hints it will use; advisory only — not enforced. */
  readonly toolHints?: readonly string[];
}

/** Output of the planner. */
export interface TaskPlan {
  /** One-line summary of the user's task as the agent understood it. */
  readonly objective: string;
  readonly steps: readonly PlanStep[];
  /** Whether the plan is final or further re-planning is expected. */
  readonly status: 'draft' | 'committed';
}

// ── Tool-call log ─────────────────────────────────────────────────────────

/** A single tool execution record kept for resume + audit. */
export interface ToolCallEntry {
  readonly iteration: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  /** Stringified result returned to the LLM. */
  readonly result: string;
  readonly success: boolean;
  readonly startedAt: number;
  readonly endedAt: number;
}

// ── Budget ────────────────────────────────────────────────────────────────

/** Three-dimensional budget — see DESIGN §3.9. */
export interface BudgetLimits {
  readonly tokens: number;
  readonly iterations: number;
  readonly durationMs: number;
}

/** Live counters tracked against `BudgetLimits`. */
export interface BudgetState {
  readonly tokensUsed: number;
  readonly iterations: number;
  readonly elapsedMs: number;
  readonly costUsd: number;
}

// ── Checkpoint ────────────────────────────────────────────────────────────

/**
 * Wire-format schema version for `TaskCheckpoint`. Bumped any time a field
 * is removed or its semantics change incompatibly. Restore-time validation
 * rejects unknown versions instead of silently coercing fields.
 */
export const TASK_CHECKPOINT_SCHEMA_VERSION = 1 as const;

/** Snapshot persisted on every state transition + every 5 iterations. */
export interface TaskCheckpoint {
  readonly schemaVersion: typeof TASK_CHECKPOINT_SCHEMA_VERSION;
  readonly taskId: string;
  readonly state: TaskState;
  readonly iteration: number;
  readonly plan: TaskPlan;
  readonly history: readonly Message[];
  readonly toolCallLog: readonly ToolCallEntry[];
  readonly budget: BudgetState;
  readonly limits: BudgetLimits;
  readonly workspace: string;
  readonly prompt: string;
  readonly startedAt: number;
  readonly lastUpdatedAt: number;
}

// ── Approval ──────────────────────────────────────────────────────────────

/** Soft-guardrail approval mode (DESIGN §3.6). */
export type ApprovalMode = 'auto' | 'always-ask' | 'allowlist';

/** Pre-tool-call approval request handed to the auditor. */
export interface ApprovalRequest {
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
}

/** Auditor verdict on a single approval request. */
export interface ApprovalDecision {
  readonly allow: boolean;
  readonly reason?: string;
}

// ── Result ────────────────────────────────────────────────────────────────

/** What the user gets back from `agent.runTask()`. */
export interface TaskResult {
  readonly taskId: string;
  readonly state: TaskState;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly cost: { readonly usd: number; readonly tokens: number };
  readonly iterations: number;
  readonly durationMs: number;
  /** Final terminal `done` reason. `done`/`aborted` only. */
  readonly reason: 'completed' | 'aborted' | 'budget' | 'error';
  /** Optional terminal error message, present when `reason === 'error'`. */
  readonly errorMessage?: string;
}

// ── Public agent surface ──────────────────────────────────────────────────

/** Input handed to `agent.runTask()`. */
export interface RunTaskInput {
  readonly prompt: string;
  readonly signal?: AbortSignal;
  /** Resume from an existing taskId checkpoint instead of starting fresh. */
  readonly resumeTaskId?: string;
  /** Plan-only mode (DESIGN §2.1). */
  readonly planOnly?: boolean;
  /** Dry-run mode — fs/shell tools refuse to mutate real state. */
  readonly dryRun?: boolean;
}

/** A re-export of the AgentLoop tool-call shape for plugin authors. */
export type CodingToolCall = ToolCallRequest;
