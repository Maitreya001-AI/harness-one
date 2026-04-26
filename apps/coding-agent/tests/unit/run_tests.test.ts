import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineRunTestsTool, detectRunner } from '../../src/tools/run_tests.js';
import type { ToolContext } from '../../src/tools/context.js';
import { toolSuccess, toolError } from 'harness-one/tools';
import type { ToolResult } from 'harness-one/tools';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-rt-')));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return { workspace, dryRun: false, maxOutputBytes: 64 * 1024, defaultTimeoutMs: 5_000 };
}

describe('detectRunner', () => {
  it('detects pnpm via lockfile', async () => {
    await fs.writeFile(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0');
    expect(await detectRunner(workspace)).toBe('pnpm');
  });

  it('detects yarn via lockfile', async () => {
    await fs.writeFile(path.join(workspace, 'yarn.lock'), '');
    expect(await detectRunner(workspace)).toBe('yarn');
  });

  it('detects npm via lockfile', async () => {
    await fs.writeFile(path.join(workspace, 'package-lock.json'), '{}');
    expect(await detectRunner(workspace)).toBe('npm');
  });

  it('detects pytest via pyproject.toml', async () => {
    await fs.writeFile(path.join(workspace, 'pyproject.toml'), '[tool.pytest]\n');
    expect(await detectRunner(workspace)).toBe('pytest');
  });

  it('returns undefined when nothing matches', async () => {
    expect(await detectRunner(workspace)).toBeUndefined();
  });
});

describe('run_tests', () => {
  it('invokes runShell with detected runner + test arg', async () => {
    await fs.writeFile(path.join(workspace, 'package.json'), '{"name":"x"}');
    const seen: Array<{ command: string; args: readonly string[] }> = [];
    const runShell = async (input: {
      readonly command: string;
      readonly args: readonly string[];
      readonly timeoutMs: number;
    }): Promise<ToolResult> => {
      seen.push({ command: input.command, args: input.args });
      return toolSuccess({ exitCode: 0 });
    };
    const tool = defineRunTestsTool(ctx(), { runShell });
    const r = await tool.execute({});
    expect(r.kind).toBe('success');
    expect(seen).toEqual([{ command: 'npm', args: ['test'] }]);
  });

  it('forwards explicit runner + extra args', async () => {
    const seen: Array<{ command: string; args: readonly string[] }> = [];
    const runShell = async (input: {
      readonly command: string;
      readonly args: readonly string[];
      readonly timeoutMs: number;
    }): Promise<ToolResult> => {
      seen.push({ command: input.command, args: input.args });
      return toolSuccess({ exitCode: 0 });
    };
    const tool = defineRunTestsTool(ctx(), { runShell });
    await tool.execute({ runner: 'pytest', args: ['-k', 'foo'] });
    expect(seen).toEqual([{ command: 'pytest', args: ['-k', 'foo'] }]);
  });

  it('returns not_found when runner cannot be detected', async () => {
    const runShell = async (): Promise<ToolResult> => toolSuccess({});
    const tool = defineRunTestsTool(ctx(), { runShell });
    const r = await tool.execute({});
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.category).toBe('not_found');
  });

  it('propagates shell errors', async () => {
    await fs.writeFile(path.join(workspace, 'package.json'), '{"name":"x"}');
    const tool = defineRunTestsTool(ctx(), {
      runShell: async (): Promise<ToolResult> =>
        toolError('exec failed', 'internal', 'check', false),
    });
    const r = await tool.execute({});
    expect(r.kind).toBe('error');
  });
});
