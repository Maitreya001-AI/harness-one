import { describe, expect, it, expectTypeOf } from 'vitest';

import {
  TASK_CHECKPOINT_SCHEMA_VERSION,
  type ApprovalDecision,
  type ApprovalMode,
  type BudgetLimits,
  type BudgetState,
  type RunTaskInput,
  type TaskCheckpoint,
  type TaskPlan,
  type TaskResult,
  type TaskState,
  type ToolCallEntry,
} from '../../src/agent/types.js';

describe('types module', () => {
  it('pins the checkpoint schema version literal', () => {
    expect(TASK_CHECKPOINT_SCHEMA_VERSION).toBe(1);
    expectTypeOf(TASK_CHECKPOINT_SCHEMA_VERSION).toEqualTypeOf<1>();
  });

  it('TaskState union accepts only the documented six states', () => {
    const states: TaskState[] = [
      'planning',
      'executing',
      'testing',
      'reviewing',
      'done',
      'aborted',
    ];
    expect(states).toHaveLength(6);
  });

  it('ApprovalMode covers auto / always-ask / allowlist', () => {
    const modes: ApprovalMode[] = ['auto', 'always-ask', 'allowlist'];
    expect(modes).toHaveLength(3);
  });

  it('compiles a fully-populated TaskCheckpoint', () => {
    const limits: BudgetLimits = {
      tokens: 200_000,
      iterations: 100,
      durationMs: 30 * 60_000,
    };
    const budget: BudgetState = {
      tokensUsed: 0,
      iterations: 0,
      elapsedMs: 0,
      costUsd: 0,
    };
    const plan: TaskPlan = {
      objective: 'fix the failing parse.ts test',
      steps: [{ id: 's1', description: 'read failing test', toolHints: ['read_file'] }],
      status: 'committed',
    };
    const log: ToolCallEntry = {
      iteration: 1,
      toolCallId: 'tc_1',
      toolName: 'read_file',
      arguments: { path: 'src/utils/parse.ts' },
      result: '...',
      success: true,
      startedAt: 0,
      endedAt: 1,
    };
    const checkpoint: TaskCheckpoint = {
      schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION,
      taskId: 'task_test',
      state: 'planning',
      iteration: 0,
      plan,
      history: [],
      toolCallLog: [log],
      budget,
      limits,
      workspace: '/tmp/workspace',
      prompt: 'fix it',
      startedAt: 100,
      lastUpdatedAt: 110,
    };
    expect(checkpoint.toolCallLog[0].toolName).toBe('read_file');
  });

  it('compiles a TaskResult with optional errorMessage', () => {
    const ok: TaskResult = {
      taskId: 't1',
      state: 'done',
      summary: 'ok',
      changedFiles: ['a.ts'],
      cost: { usd: 0.01, tokens: 100 },
      iterations: 3,
      durationMs: 5000,
      reason: 'completed',
    };
    const err: TaskResult = {
      ...ok,
      state: 'aborted',
      reason: 'error',
      errorMessage: 'boom',
    };
    expect(ok.reason).toBe('completed');
    expect(err.errorMessage).toBe('boom');
  });

  it('compiles RunTaskInput with all optional fields', () => {
    const input: RunTaskInput = {
      prompt: 'do the thing',
      planOnly: true,
      dryRun: true,
      resumeTaskId: 't_old',
      signal: new AbortController().signal,
    };
    expect(input.prompt).toBe('do the thing');
  });

  it('ApprovalDecision rejects when allow is false', () => {
    const decision: ApprovalDecision = { allow: false, reason: 'shell pattern blocked' };
    expect(decision.allow).toBe(false);
  });
});
