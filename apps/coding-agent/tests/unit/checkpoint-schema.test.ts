import { describe, expect, it } from 'vitest';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

import { assertCheckpointShape } from '../../src/memory/schema.js';
import {
  TASK_CHECKPOINT_SCHEMA_VERSION,
  type TaskCheckpoint,
} from '../../src/agent/types.js';

function valid(): TaskCheckpoint {
  return {
    schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION,
    taskId: 't1',
    state: 'planning',
    iteration: 0,
    plan: { objective: 'do thing', steps: [], status: 'draft' },
    history: [],
    toolCallLog: [],
    budget: { tokensUsed: 0, iterations: 0, elapsedMs: 0, costUsd: 0 },
    limits: { tokens: 1000, iterations: 10, durationMs: 1000 },
    workspace: '/tmp/ws',
    prompt: 'do thing',
    startedAt: 0,
    lastUpdatedAt: 0,
  };
}

describe('assertCheckpointShape', () => {
  it('passes on a fully-populated checkpoint', () => {
    expect(() => assertCheckpointShape(valid())).not.toThrow();
  });

  it.each([null, 1, 'string', undefined])('rejects non-object input %p', (v) => {
    expect(() => assertCheckpointShape(v)).toThrow(HarnessError);
  });

  it('rejects unknown schemaVersion', () => {
    let caught: unknown;
    try {
      assertCheckpointShape({ ...valid(), schemaVersion: 99 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).code).toBe(HarnessErrorCode.MEMORY_CORRUPT);
  });

  it.each([
    { taskId: '' },
    { state: 'unknown' },
    { iteration: -1 },
    { iteration: 1.5 },
    { plan: 'not-object' },
    { history: 'not-array' },
    { toolCallLog: 'not-array' },
    { budget: { tokensUsed: -1, iterations: 0, elapsedMs: 0, costUsd: 0 } },
    { limits: { tokens: 0, iterations: 0, durationMs: 0 } },
  ])('rejects malformed shape %p', (override) => {
    expect(() =>
      assertCheckpointShape({ ...valid(), ...(override as Record<string, unknown>) }),
    ).toThrow(HarnessError);
  });

  it('rejects bad plan.status', () => {
    expect(() =>
      assertCheckpointShape({
        ...valid(),
        plan: { objective: 'x', steps: [], status: 'final' },
      }),
    ).toThrow();
  });
});
