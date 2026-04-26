import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineGrepTool } from '../../src/tools/grep.js';
import type { ToolContext } from '../../src/tools/context.js';

let workspace: string;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-grep-')));
  await fs.mkdir(path.join(workspace, 'src'));
  await fs.mkdir(path.join(workspace, 'node_modules'));
  await fs.writeFile(path.join(workspace, 'src/a.ts'), 'export const FOO = 1;\nexport const BAR = 2;\n');
  await fs.writeFile(path.join(workspace, 'src/b.ts'), 'const FOO = "hello FOO";\n');
  await fs.writeFile(path.join(workspace, 'node_modules/skipme.ts'), 'FOO');
  await fs.writeFile(path.join(workspace, '.env'), 'FOO=secret');
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return { workspace, dryRun: false, maxOutputBytes: 64 * 1024, defaultTimeoutMs: 1000 };
}

describe('grep', () => {
  it('finds regex matches across workspace', async () => {
    const tool = defineGrepTool(ctx());
    const r = await tool.execute({ pattern: 'FOO' });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { matches: Array<{ path: string }> };
      const paths = data.matches.map((m) => m.path).sort();
      expect(paths).toContain(path.join('src', 'a.ts'));
      expect(paths).toContain(path.join('src', 'b.ts'));
      // node_modules and .env must be excluded
      expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
      expect(paths.some((p) => p === '.env')).toBe(false);
    }
  });

  it('respects literal flag (no regex interpretation)', async () => {
    await fs.writeFile(path.join(workspace, 'src/c.ts'), 'a.b.c\n');
    const tool = defineGrepTool(ctx());
    const r = await tool.execute({ pattern: 'a.b.c', literal: true, path: 'src' });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { matches: unknown[] };
      expect(data.matches.length).toBeGreaterThan(0);
    }
  });

  it('truncates when matches exceed limit', async () => {
    const tool = defineGrepTool(ctx());
    const r = await tool.execute({ pattern: 'FOO', limit: 1 });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { truncated: boolean; matches: unknown[] };
      expect(data.matches).toHaveLength(1);
      expect(data.truncated).toBe(true);
    }
  });

  it('returns validation error for invalid regex', async () => {
    const tool = defineGrepTool(ctx());
    const r = await tool.execute({ pattern: '(' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.category).toBe('validation');
  });

  it('honors AbortSignal', async () => {
    const ctrl = new AbortController();
    const tool = defineGrepTool(ctx());
    ctrl.abort();
    const r = await tool.execute({ pattern: 'FOO' }, ctrl.signal);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.category).toBe('timeout');
  });
});
