import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildMvpToolSet } from '../../src/tools/registry.js';
import type { ToolContext } from '../../src/tools/context.js';

let workspace: string;

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-reg-')));
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return { workspace, dryRun: true, maxOutputBytes: 64 * 1024, defaultTimeoutMs: 1000 };
}

describe('buildMvpToolSet', () => {
  it('registers all seven MVP tools', () => {
    const built = buildMvpToolSet({
      ctx: ctx(),
      shell: { commandAllowlist: ['node'] },
    });
    const names = built.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'git_status',
        'grep',
        'list_dir',
        'read_file',
        'run_tests',
        'shell',
        'write_file',
      ].sort(),
    );
  });

  it('exposes a registry that lists every tool', () => {
    const built = buildMvpToolSet({
      ctx: ctx(),
      shell: { commandAllowlist: ['node'] },
    });
    expect(built.registry.list().length).toBe(7);
  });
});
