import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineGitStatusTool, parsePorcelain } from '../../src/tools/git_status.js';
import type { ToolContext } from '../../src/tools/context.js';
import { toolSuccess, toolError } from 'harness-one/tools';
import type { ToolResult } from 'harness-one/tools';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-gs-')));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return { workspace, dryRun: false, maxOutputBytes: 64 * 1024, defaultTimeoutMs: 5_000 };
}

describe('parsePorcelain', () => {
  it('parses standard staged + unstaged entries', () => {
    const out = parsePorcelain('M  src/a.ts\n?? src/b.ts\n');
    expect(out).toEqual([
      { status: 'M ', path: 'src/a.ts' },
      { status: '??', path: 'src/b.ts' },
    ]);
  });

  it('extracts the new path of renames', () => {
    const out = parsePorcelain('R  old.ts -> new.ts\n');
    expect(out).toEqual([{ status: 'R ', path: 'new.ts' }]);
  });

  it('returns empty list on empty stdout', () => {
    expect(parsePorcelain('')).toEqual([]);
  });
});

describe('git_status', () => {
  it('parses non-empty status output', async () => {
    const runShell = async (input: {
      readonly command: string;
      readonly args: readonly string[];
      readonly timeoutMs: number;
    }): Promise<ToolResult> => {
      expect(input.command).toBe('git');
      expect(input.args).toEqual(['status', '--porcelain=v1']);
      return toolSuccess({ stdout: 'M  src/a.ts\n', stderr: '', exitCode: 0 });
    };
    const tool = defineGitStatusTool(ctx(), { runShell });
    const r = await tool.execute({});
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { entries: Array<{ path: string }>; count: number };
      expect(data.count).toBe(1);
      expect(data.entries[0].path).toBe('src/a.ts');
    }
  });

  it('appends pathspec when provided', async () => {
    let captured: readonly string[] = [];
    const runShell = async (input: {
      readonly command: string;
      readonly args: readonly string[];
      readonly timeoutMs: number;
    }): Promise<ToolResult> => {
      captured = input.args;
      return toolSuccess({ stdout: '', stderr: '', exitCode: 0 });
    };
    const tool = defineGitStatusTool(ctx(), { runShell });
    await tool.execute({ pathspec: 'src/' });
    expect(captured).toEqual(['status', '--porcelain=v1', '--', 'src/']);
  });

  it('reports non-zero exit as internal error', async () => {
    const runShell = async (): Promise<ToolResult> =>
      toolSuccess({ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 });
    const tool = defineGitStatusTool(ctx(), { runShell });
    const r = await tool.execute({});
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.category).toBe('internal');
  });

  it('propagates a failed shell result unchanged', async () => {
    const runShell = async (): Promise<ToolResult> =>
      toolError('spawn fail', 'internal', 'fix path', false);
    const tool = defineGitStatusTool(ctx(), { runShell });
    const r = await tool.execute({});
    expect(r.kind).toBe('error');
  });
});
