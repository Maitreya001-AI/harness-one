/**
 * Coding-agent runTask orchestrator.
 *
 * Wires the harness-one `AgentLoop` to:
 *  - the seven MVP tools (S3)
 *  - the input/output guardrail pipelines (S4)
 *  - the soft-guardrail auditor (approval flow)
 *  - the checkpoint manager (S5)
 *  - the three-dim budget tracker (this stage)
 *
 * The "state machine" (DESIGN §3.4) is layered as a thin observer over the
 * AgentLoop event stream:
 *
 *   - first iteration → `planning → executing`
 *   - `run_tests` invocation → `executing → testing`
 *   - test pass/fail → `testing → reviewing` / `testing → executing`
 *   - LLM emits final assistant message with no tool calls → `reviewing →
 *     done`
 *
 * Checkpoints are persisted on every state transition + every Nth
 * iteration via the {@link CheckpointManager}, satisfying DESIGN §3.7.
 *
 * @module
 */

import type {
  AgentAdapter,
  Message,
  ToolCallRequest,
  ToolSchema,
} from 'harness-one/core';
import { createAgentLoop, HarnessError, HarnessErrorCode } from 'harness-one/core';
import type { ToolDefinition, ToolRegistry } from 'harness-one/tools';
import type { CostTracker, Logger } from 'harness-one/observe';

import type { Auditor } from '../guardrails/auditor.js';
import { createCodingGuardrails } from '../guardrails/policy.js';
import { createBudgetTracker } from './budget.js';
import { assertTransition } from './state-machine.js';
import { buildInitialMessages, buildInitialPlan } from './planner.js';
import { type CheckpointManager } from '../memory/checkpoint.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
  BudgetLimits,
  RunTaskInput,
  TaskCheckpoint,
  TaskResult,
  TaskState,
  ToolCallEntry,
} from './types.js';

export interface RunTaskDeps {
  readonly registry: ToolRegistry;
  readonly tools: readonly ToolDefinition<unknown>[];
  readonly checkpoints: CheckpointManager;
  readonly costTracker: CostTracker;
  readonly auditor: Auditor;
  readonly logger?: Logger;
  readonly model?: string;
  readonly limits: BudgetLimits;
  readonly workspace: string;
  /** Adapter from `@harness-one/anthropic` (or compatible). */
  readonly adapter: AgentAdapter;
  readonly approvalMode: string;
  /** Records files mutated by write_file calls (mutated by the tools layer). */
  readonly recordChangedFile: (relPath: string) => void;
  /** Read-only changed-files accessor. */
  readonly getChangedFiles: () => readonly string[];
}

/** Internal type seam used by the auditor → loop bridge. */
export type ApprovalGate = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface RunTaskOutcome {
  readonly result: TaskResult;
  readonly finalCheckpoint: TaskCheckpoint;
}

const PLAN_ONLY_SUMMARY = '[plan-only] Initial plan committed; no tools executed.';

/**
 * Drive a single task to completion.
 *
 * The function is itself an async generator-of-events for tests, but we
 * collect into a TaskResult for the public API. Concrete event yields
 * are kept available via `runTaskEvents` to keep the CLI rendering
 * decoupled from the orchestrator.
 */
export async function runTask(
  deps: RunTaskDeps,
  input: RunTaskInput,
  taskId: string,
): Promise<RunTaskOutcome> {
  const startedAt = Date.now();
  const checkpoints = deps.checkpoints;
  const checkpointSeed: TaskCheckpoint = await prepareInitialCheckpoint(deps, input, taskId);

  if (input.planOnly) {
    const persisted = await checkpoints.persist({
      ...checkpointSeed,
      plan: { ...buildInitialPlan(input.prompt), status: 'committed' },
    });
    return {
      finalCheckpoint: persisted,
      result: {
        taskId,
        state: 'planning',
        summary: PLAN_ONLY_SUMMARY,
        changedFiles: [],
        cost: { usd: 0, tokens: 0 },
        iterations: 0,
        durationMs: Date.now() - startedAt,
        reason: 'completed',
      },
    };
  }

  const guardrails = createCodingGuardrails();
  const budget = createBudgetTracker({
    limits: deps.limits,
    costTracker: deps.costTracker,
    initial: checkpointSeed.budget,
  });

  const toolSchemas: ToolSchema[] = deps.tools.map(
    (t): ToolSchema => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.responseFormat !== undefined && { responseFormat: t.responseFormat }),
    }),
  );

  let checkpoint = checkpointSeed;
  let summary = '';
  let lastErrorMessage: string | undefined;
  let aborted = false;
  let abortReason: TaskResult['reason'] = 'completed';

  const aborter = new AbortController();
  if (input.signal) {
    if (input.signal.aborted) aborter.abort();
    else input.signal.addEventListener('abort', () => aborter.abort(), { once: true });
  }

  const loop = createAgentLoop({
    adapter: deps.adapter,
    tools: toolSchemas,
    maxIterations: deps.limits.iterations,
    maxTotalTokens: deps.limits.tokens,
    maxDurationMs: deps.limits.durationMs,
    inputPipeline: guardrails.input,
    outputPipeline: guardrails.output,
    signal: aborter.signal,
    ...(deps.logger !== undefined && { logger: deps.logger }),
    onToolCall: async (call: ToolCallRequest) => {
      const startedToolAt = Date.now();
      const tool = deps.registry.list().find((t) => t.name === call.name);
      if (!tool) {
        return { success: false, error: `Unknown tool: ${call.name}` };
      }
      const args = parseArgs(call.arguments);
      const decision = await deps.auditor.decide({
        toolName: call.name,
        arguments: args,
        reason: `LLM requested ${call.name}`,
      });
      if (!decision.allow) {
        const result = { success: false, error: `denied: ${decision.reason ?? 'unspecified'}` };
        const entry: ToolCallEntry = {
          iteration: checkpoint.iteration,
          toolCallId: call.id,
          toolName: call.name,
          arguments: args,
          result: JSON.stringify(result),
          success: false,
          startedAt: startedToolAt,
          endedAt: Date.now(),
        };
        checkpoint = checkpoints.recordToolCall(checkpoint, entry);
        return result;
      }
      const result = await deps.registry.execute({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
      const entry: ToolCallEntry = {
        iteration: checkpoint.iteration,
        toolCallId: call.id,
        toolName: call.name,
        arguments: args,
        result: JSON.stringify(result),
        success: result.kind === 'success',
        startedAt: startedToolAt,
        endedAt: Date.now(),
      };
      checkpoint = checkpoints.recordToolCall(checkpoint, entry);

      // State-machine: `run_tests` → testing
      if (call.name === 'run_tests') {
        await transition(checkpoints, checkpoint, 'testing').then((next) => {
          checkpoint = next;
        });
      }
      return result;
    },
  });

  const messages: Message[] = buildInitialMessages({
    prompt: input.prompt,
    workspace: deps.workspace,
    toolNames: deps.tools.map((t) => t.name),
    approvalMode: deps.approvalMode,
    ...(input.dryRun !== undefined && { dryRun: input.dryRun }),
  });

  try {
    for await (const event of loop.run(messages)) {
      if (aborter.signal.aborted) break;
      switch (event.type) {
        case 'iteration_start': {
          const snapshot = budget.recordIteration();
          if (checkpoint.state === 'planning') {
            checkpoint = await transition(checkpoints, checkpoint, 'executing');
          }
          checkpoint = checkpoints.recordIteration(checkpoint, {
            budget: snapshot.state,
          });
          checkpoint = await checkpoints.maybePersist(
            { ...checkpoint, iteration: checkpoint.iteration - 1 },
            checkpoint,
          );
          if (snapshot.exhaustedAxis !== null) {
            aborted = true;
            abortReason = 'budget';
            lastErrorMessage = `Budget exhausted on axis: ${snapshot.exhaustedAxis}`;
            aborter.abort();
          }
          break;
        }
        case 'message': {
          const usage = event.usage;
          if (usage) budget.recordUsage(usage, deps.model);
          const text = event.message.role === 'assistant' ? (event.message.content ?? '') : '';
          if (text.length > 0) summary = text;
          break;
        }
        case 'tool_result': {
          if (checkpoint.state === 'testing') {
            const failed = isFailedToolResult(event.result);
            const next: TaskState = failed ? 'executing' : 'reviewing';
            checkpoint = await transition(checkpoints, checkpoint, next);
          }
          break;
        }
        case 'guardrail_blocked': {
          aborted = true;
          abortReason = 'error';
          lastErrorMessage = `guardrail blocked at ${event.phase}: ${event.guardName}`;
          break;
        }
        case 'error': {
          aborted = true;
          abortReason = 'error';
          lastErrorMessage = event.error instanceof Error ? event.error.message : String(event.error);
          break;
        }
        case 'done': {
          if (event.reason === 'aborted') {
            aborted = true;
            abortReason = lastErrorMessage ? abortReason : 'aborted';
          }
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    aborted = true;
    abortReason = 'error';
    lastErrorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    loop.dispose();
  }

  if (!aborted && checkpoint.state !== 'reviewing' && checkpoint.state !== 'done') {
    // Fast-forward through `reviewing → done` regardless of how the loop
    // terminated. `planning → done` is not a legal transition (no useful
    // work happened); fold that case into the aborted branch + flag the
    // outcome so the public `reason` reflects the missed work.
    if (checkpoint.state === 'planning') {
      checkpoint = await transition(checkpoints, checkpoint, 'aborted');
      aborted = true;
      abortReason = lastErrorMessage ? 'error' : 'aborted';
    } else {
      if (checkpoint.state === 'executing' || checkpoint.state === 'testing') {
        checkpoint = await transition(checkpoints, checkpoint, 'reviewing');
      }
      checkpoint = await transition(checkpoints, checkpoint, 'done');
    }
  } else if (aborted) {
    if (checkpoint.state !== 'aborted') {
      checkpoint = await transition(checkpoints, checkpoint, 'aborted');
    }
  }

  const snapshot = budget.tick();
  checkpoint = await checkpoints.persist({
    ...checkpoint,
    budget: snapshot.state,
  });

  const result: TaskResult = {
    taskId,
    state: checkpoint.state,
    summary: summary.length > 0 ? summary : aborted ? `aborted (${abortReason})` : 'completed',
    changedFiles: deps.getChangedFiles(),
    cost: { usd: snapshot.state.costUsd, tokens: snapshot.state.tokensUsed },
    iterations: checkpoint.iteration,
    durationMs: Date.now() - startedAt,
    reason: aborted ? abortReason : 'completed',
    ...(lastErrorMessage !== undefined && { errorMessage: lastErrorMessage }),
  };
  return { result, finalCheckpoint: checkpoint };
}

/** Wrapper around the state-machine assertion + checkpoint persistence. */
async function transition(
  manager: CheckpointManager,
  cp: TaskCheckpoint,
  to: TaskState,
): Promise<TaskCheckpoint> {
  if (cp.state === to) return cp;
  assertTransition(cp.state, to);
  return manager.persist({ ...cp, state: to });
}

async function prepareInitialCheckpoint(
  deps: RunTaskDeps,
  input: RunTaskInput,
  taskId: string,
): Promise<TaskCheckpoint> {
  if (input.resumeTaskId) {
    const restored = await deps.checkpoints.load(input.resumeTaskId);
    if (!restored) {
      throw new HarnessError(
        `No checkpoint found for taskId=${input.resumeTaskId}`,
        HarnessErrorCode.MEMORY_NOT_FOUND,
        'List checkpoints with `harness-coding ls` or run a fresh task',
      );
    }
    return restored;
  }
  const initial = deps.checkpoints.initial({
    taskId,
    prompt: input.prompt,
    workspace: deps.workspace,
    limits: deps.limits,
  });
  return deps.checkpoints.persist(initial);
}

function parseArgs(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Detect a failed tool result without coupling to harness-one internals.
 * Accepts both the structured envelope (`{ kind: 'error' }`) and the
 * common `{ success: false }` shape used by the registry contract.
 */
function isFailedToolResult(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj['kind'] === 'error') return true;
  if (obj['success'] === false) return true;
  return false;
}
