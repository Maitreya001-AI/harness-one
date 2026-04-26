import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createInMemoryStore,
  createFileSystemStore,
} from 'harness-one/memory';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

import {
  DEFAULT_FLUSH_EVERY_N_ITERATIONS,
  createCheckpointManager,
  parseStoredCheckpoint,
} from '../../src/memory/checkpoint.js';
import type {
  BudgetLimits,
  TaskCheckpoint,
} from '../../src/agent/types.js';
import { TASK_CHECKPOINT_SCHEMA_VERSION } from '../../src/agent/types.js';

const limits: BudgetLimits = { tokens: 100_000, iterations: 50, durationMs: 60_000 };

function bootstrap(): {
  readonly store: ReturnType<typeof createInMemoryStore>;
  readonly mgr: ReturnType<typeof createCheckpointManager>;
} {
  const store = createInMemoryStore();
  const mgr = createCheckpointManager({ store });
  return { store, mgr };
}

describe('createCheckpointManager', () => {
  it('rejects non-positive flushEveryNIterations', () => {
    const store = createInMemoryStore();
    expect(() => createCheckpointManager({ store, flushEveryNIterations: 0 })).toThrow(
      HarnessError,
    );
    expect(() => createCheckpointManager({ store, flushEveryNIterations: -1 })).toThrow(
      HarnessError,
    );
  });

  it('initial() builds a fresh planning checkpoint', () => {
    const { mgr } = bootstrap();
    const cp = mgr.initial({
      taskId: 'task_a',
      prompt: 'fix it',
      workspace: '/tmp/ws',
      limits,
    });
    expect(cp.taskId).toBe('task_a');
    expect(cp.state).toBe('planning');
    expect(cp.schemaVersion).toBe(TASK_CHECKPOINT_SCHEMA_VERSION);
    expect(cp.plan.objective).toBe('fix it');
  });

  it('persist() writes once + load() round-trips', async () => {
    const { mgr } = bootstrap();
    const cp = mgr.initial({
      taskId: 'task_b',
      prompt: 'r',
      workspace: '/tmp/ws',
      limits,
    });
    await mgr.persist(cp);
    const back = await mgr.load('task_b');
    expect(back?.taskId).toBe('task_b');
    expect(back?.state).toBe('planning');
  });

  it('persist() updates an existing entry instead of duplicating it', async () => {
    const { store, mgr } = bootstrap();
    const cp = mgr.initial({
      taskId: 'task_c',
      prompt: 'r',
      workspace: '/tmp/ws',
      limits,
    });
    await mgr.persist(cp);
    await mgr.persist({ ...cp, state: 'executing' });
    expect(await store.count()).toBe(1);
    const back = await mgr.load('task_c');
    expect(back?.state).toBe('executing');
  });

  it('maybePersist() flushes on state transition', async () => {
    const { store, mgr } = bootstrap();
    const cp = mgr.initial({
      taskId: 'task_d',
      prompt: 'r',
      workspace: '/tmp/ws',
      limits,
    });
    expect(await store.count()).toBe(0);
    const next = { ...cp, state: 'executing' as const };
    await mgr.maybePersist(cp, next);
    expect(await store.count()).toBe(1);
  });

  it('maybePersist() flushes every N iterations even without state change', async () => {
    const { store, mgr } = bootstrap();
    const cp = mgr.initial({
      taskId: 'task_e',
      prompt: 'r',
      workspace: '/tmp/ws',
      limits,
    });
    let cur = { ...cp, state: 'executing' as const };
    await mgr.persist(cur); // baseline
    const baseline = await store.count();
    for (let i = 1; i <= DEFAULT_FLUSH_EVERY_N_ITERATIONS - 1; i++) {
      const next = { ...cur, iteration: i };
      await mgr.maybePersist(cur, next);
      cur = next;
    }
    expect(await store.count()).toBe(baseline);
    const flush = { ...cur, iteration: DEFAULT_FLUSH_EVERY_N_ITERATIONS };
    await mgr.maybePersist(cur, flush);
    // Same key — count stays at baseline; just verify load returns the new iteration.
    const back = await mgr.load('task_e');
    expect(back?.iteration).toBe(DEFAULT_FLUSH_EVERY_N_ITERATIONS);
  });

  it('list() returns summaries for every persisted task', async () => {
    const { mgr } = bootstrap();
    for (const id of ['t1', 't2', 't3']) {
      const cp = mgr.initial({
        taskId: id,
        prompt: id,
        workspace: '/tmp/ws',
        limits,
      });
      await mgr.persist(cp);
    }
    const summaries = await mgr.list();
    expect(summaries.length).toBe(3);
    expect(new Set(summaries.map((s) => s.taskId))).toEqual(new Set(['t1', 't2', 't3']));
  });

  it('list() skips corrupt entries with logger warning', async () => {
    const warnings: Array<{ msg: string; meta?: unknown }> = [];
    const store = createInMemoryStore();
    const logger = { warn: (msg: string, meta?: Record<string, unknown>) => warnings.push({ msg, meta }) };
    const mgr = createCheckpointManager({ store, logger });
    // inject corrupt
    await store.write({
      key: 'coding-agent.task:bad',
      content: '{not json',
      grade: 'critical',
      tags: ['task-checkpoint', 'coding-agent'],
    });
    const summaries = await mgr.list();
    expect(summaries).toEqual([]);
    expect(warnings.length).toBe(1);
  });

  it('recordToolCall() appends entries without changing iteration', () => {
    const { mgr } = bootstrap();
    const cp = mgr.initial({
      taskId: 't',
      prompt: 'p',
      workspace: '/tmp/ws',
      limits,
    });
    const next = mgr.recordToolCall(cp, {
      iteration: 1,
      toolCallId: 'tc',
      toolName: 'read_file',
      arguments: { path: 'x' },
      result: '...',
      success: true,
      startedAt: 1,
      endedAt: 2,
    });
    expect(next.iteration).toBe(0);
    expect(next.toolCallLog).toHaveLength(1);
  });

  it('recordIteration() bumps counter + budget', () => {
    const { mgr } = bootstrap();
    const cp = mgr.initial({
      taskId: 't',
      prompt: 'p',
      workspace: '/tmp/ws',
      limits,
    });
    const next = mgr.recordIteration(cp, {
      state: 'executing',
      budget: { tokensUsed: 100, iterations: 1, elapsedMs: 10, costUsd: 0.01 },
    });
    expect(next.iteration).toBe(1);
    expect(next.state).toBe('executing');
    expect(next.budget.tokensUsed).toBe(100);
  });
});

describe('parseStoredCheckpoint', () => {
  it('throws MEMORY_CORRUPT on invalid JSON', async () => {
    const store = createInMemoryStore();
    const entry = await store.write({
      key: 'k',
      content: '{not json',
      grade: 'critical',
    });
    let caught: unknown;
    try {
      parseStoredCheckpoint(entry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).code).toBe(HarnessErrorCode.MEMORY_CORRUPT);
  });

  it('round-trips a valid stored checkpoint', async () => {
    const cp: TaskCheckpoint = {
      schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION,
      taskId: 'r',
      state: 'planning',
      iteration: 0,
      plan: { objective: 'p', steps: [], status: 'draft' },
      history: [],
      toolCallLog: [],
      budget: { tokensUsed: 0, iterations: 0, elapsedMs: 0, costUsd: 0 },
      limits,
      workspace: '/tmp/ws',
      prompt: 'p',
      startedAt: 1,
      lastUpdatedAt: 1,
    };
    const store = createInMemoryStore();
    const entry = await store.write({
      key: 'k',
      content: JSON.stringify(cp),
      grade: 'critical',
    });
    const back = parseStoredCheckpoint(entry);
    expect(back.taskId).toBe('r');
  });
});

describe('FsMemoryStore integration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-cp-')));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('persists and loads via FsMemoryStore', async () => {
    const store = createFileSystemStore({ directory: dir });
    const mgr = createCheckpointManager({ store });
    const cp = mgr.initial({
      taskId: 'fs1',
      prompt: 'p',
      workspace: '/tmp/ws',
      limits,
    });
    await mgr.persist(cp);
    const back = await mgr.load('fs1');
    expect(back?.taskId).toBe('fs1');
  });
});
