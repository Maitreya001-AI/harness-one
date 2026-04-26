import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineShellTool } from '../../src/tools/shell.js';
import type { ToolContext } from '../../src/tools/context.js';

let workspace: string;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-shell-')));
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspace,
    dryRun: false,
    maxOutputBytes: 64 * 1024,
    defaultTimeoutMs: 5_000,
    ...overrides,
  };
}

describe('shell tool', () => {
  it('runs an allowlisted echo (true: it spawns node -e)', async () => {
    const tool = defineShellTool(ctx(), { commandAllowlist: ['node'] });
    const r = await tool.execute({
      command: 'node',
      args: ['-e', 'process.stdout.write("hello"); process.exit(0)'],
      timeoutMs: 5_000,
    });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { stdout: string; exitCode: number | null };
      expect(data.stdout).toBe('hello');
      expect(data.exitCode).toBe(0);
    }
  });

  it('refuses non-allowlisted commands', async () => {
    const tool = defineShellTool(ctx(), { commandAllowlist: ['node'] });
    const r = await tool.execute({ command: 'rm', args: ['-rf', '/'] });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.category).toBe('permission');
  });

  it('respects approval-deny', async () => {
    const tool = defineShellTool(
      ctx({
        requireApproval: async () => ({ allow: false, reason: 'no' }),
      }),
      { commandAllowlist: ['node'] },
    );
    const r = await tool.execute({ command: 'node', args: ['-e', 'process.exit(0)'] });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.category).toBe('permission');
  });

  it('returns dry-run record without spawning', async () => {
    const tool = defineShellTool(ctx({ dryRun: true }), { commandAllowlist: ['node'] });
    const r = await tool.execute({ command: 'node', args: ['-e', 'process.exit(7)'] });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { dryRun: boolean };
      expect(data.dryRun).toBe(true);
    }
  });

  it('times out long-running processes', async () => {
    const tool = defineShellTool(ctx(), { commandAllowlist: ['node'] });
    const r = await tool.execute({
      command: 'node',
      args: ['-e', 'setInterval(()=>{}, 10000)'],
      timeoutMs: 200,
    });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.category).toBe('timeout');
  }, 10_000);

  it('captures non-zero exit codes', async () => {
    const tool = defineShellTool(ctx(), { commandAllowlist: ['node'] });
    const r = await tool.execute({
      command: 'node',
      args: ['-e', 'process.exit(42)'],
      timeoutMs: 5_000,
    });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { exitCode: number | null };
      expect(data.exitCode).toBe(42);
    }
  });

  it('truncates excessive stdout', async () => {
    const tool = defineShellTool(ctx({ maxOutputBytes: 64 * 1024 }), {
      commandAllowlist: ['node'],
      maxOutputBytes: 32,
    });
    const r = await tool.execute({
      command: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(200))'],
      timeoutMs: 5_000,
    });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { stdoutTruncated: boolean; stdout: string };
      expect(data.stdoutTruncated).toBe(true);
      expect(data.stdout.length).toBe(32);
    }
  });

  it('reports spawn errors as internal', async () => {
    const tool = defineShellTool(ctx(), { commandAllowlist: ['definitelynotacommand'] });
    const r = await tool.execute({
      command: 'definitelynotacommand',
      args: [],
      timeoutMs: 1_000,
    });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.category).toBe('internal');
  });

  it('strips secret env vars from subprocess', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-12345';
    try {
      const tool = defineShellTool(ctx(), { commandAllowlist: ['node'] });
      const r = await tool.execute({
        command: 'node',
        args: [
          '-e',
          'process.stdout.write(process.env.ANTHROPIC_API_KEY ?? "ABSENT")',
        ],
        timeoutMs: 5_000,
      });
      expect(r.kind).toBe('success');
      if (r.kind === 'success') {
        const data = r.data as { stdout: string };
        expect(data.stdout).toBe('ABSENT');
      }
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
