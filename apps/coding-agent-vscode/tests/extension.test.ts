import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as shim from './vscode-shim.js';
import { activate, deactivate } from '../src/extension.js';
import {
  buildAgentForExtension,
  collectListReport,
  formatTaskResult,
} from '../src/run-task.js';
import type * as vscode from 'vscode';
import type { TaskResult } from 'harness-one-coding';

type Ctx = vscode.ExtensionContext;
const fakeCtx = (subscriptions: { dispose: () => void }[] = []): Ctx =>
  ({ subscriptions } as unknown as Ctx);

let workspace: string;
let checkpointDir: string;

const noopAdapter = async () => ({
  name: 'mock',
  async chat() {
    return {
      message: { role: 'assistant' as const, content: 'noop' },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
});

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-vsc-')));
  checkpointDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-vsc-cp-')));
  shim.__reset();
  shim.__setWorkspace(workspace);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(checkpointDir, { recursive: true, force: true });
  shim.__reset();
});

describe('activate / deactivate', () => {
  it('registers all three commands and tears down on deactivate', () => {
    const subscriptions: Array<{ dispose: () => void }> = [];
    activate(fakeCtx(subscriptions));
    const ids = [...shim.commands.registry.keys()].sort();
    expect(ids).toEqual([
      'harness-coding.list',
      'harness-coding.resume',
      'harness-coding.run',
    ]);
    for (const sub of subscriptions) sub.dispose();
    deactivate();
    expect(shim.commands.registry.size).toBe(0);
  });
});

describe('buildAgentForExtension', () => {
  it('reads model + budget from configuration', async () => {
    shim.__setConfig({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 5_000,
      maxIterations: 7,
      maxDurationMinutes: 2,
      approval: 'auto',
    });
    const ctx = fakeCtx();
    const agent = await buildAgentForExtension({
      context: ctx,
      env: {},
      adapterFactory: noopAdapter,
      checkpointDir,
    });
    expect(agent.workspace).toBe(workspace);
    expect(agent.limits.tokens).toBe(5_000);
    expect(agent.limits.iterations).toBe(7);
    expect(agent.limits.durationMs).toBe(2 * 60_000);
    await agent.shutdown();
  });

  it('rejects when api key missing and no factory override', async () => {
    shim.__setConfig({ approval: 'auto' });
    const ctx = fakeCtx();
    await expect(
      buildAgentForExtension({ context: ctx, env: {} }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('formatTaskResult', () => {
  const result: TaskResult = {
    taskId: 't1',
    state: 'done',
    summary: 'all good',
    changedFiles: ['a.ts'],
    cost: { usd: 0.01, tokens: 100 },
    iterations: 2,
    durationMs: 1234,
    reason: 'completed',
  };

  it('renders task header + cost + summary', () => {
    const out = formatTaskResult(result);
    expect(out).toContain('t1');
    expect(out).toContain('a.ts');
    expect(out).toContain('all good');
  });

  it('renders error message when present', () => {
    const out = formatTaskResult({ ...result, reason: 'error', errorMessage: 'boom' });
    expect(out).toContain('Error: boom');
  });
});

describe('collectListReport', () => {
  it('returns notice when no checkpoints', async () => {
    shim.__setConfig({ approval: 'auto' });
    const ctx = fakeCtx();
    const agent = await buildAgentForExtension({
      context: ctx,
      env: {},
      adapterFactory: noopAdapter,
      checkpointDir,
    });
    expect(await collectListReport(agent)).toBe('No checkpoints found.');
    await agent.shutdown();
  });
});
