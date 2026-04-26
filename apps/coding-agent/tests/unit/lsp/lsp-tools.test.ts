import { describe, expect, it } from 'vitest';
import type { spawn as nodeSpawn } from 'node:child_process';

import { createLspToolset } from '../../../src/tools/lsp/lsp-tools.js';
import { createMockLspSpawner } from './mock-server.js';

const SAMPLE_LOC = {
  uri: 'file:///tmp/ws/a.ts',
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
  },
};

describe('LspToolset', () => {
  it('registers lsp_definition + lsp_references with the right capabilities', () => {
    const handle = createMockLspSpawner(() => ({ capabilities: {} }));
    const set = createLspToolset({
      command: 'mock',
      workspace: '/tmp/ws',
      spawner: handle.spawner as unknown as typeof nodeSpawn,
    });
    expect(set.tools.map((t) => t.name).sort()).toEqual(['lsp_definition', 'lsp_references']);
    for (const tool of set.tools) {
      expect(tool.capabilities).toContain('readonly');
      expect(tool.capabilities).toContain('filesystem');
    }
  });

  it('lsp_definition returns the location list (single → array normalisation)', async () => {
    const handle = createMockLspSpawner((req) => {
      if (req.method === 'initialize') return { capabilities: {} };
      if (req.method === 'textDocument/definition') return SAMPLE_LOC;
      return null;
    });
    const set = createLspToolset({
      command: 'mock',
      workspace: '/tmp/ws',
      spawner: handle.spawner as unknown as typeof nodeSpawn,
      requestTimeoutMs: 500,
    });
    const def = set.tools.find((t) => t.name === 'lsp_definition')!;
    const r = await def.execute({ path: 'a.ts', line: 0, character: 0 });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { locations: unknown[] };
      expect(data.locations).toHaveLength(1);
    }
    await set.dispose();
  });

  it('lsp_references caps locations at 200', async () => {
    const big = Array.from({ length: 250 }, () => SAMPLE_LOC);
    const handle = createMockLspSpawner((req) => {
      if (req.method === 'initialize') return { capabilities: {} };
      if (req.method === 'textDocument/references') return big;
      return null;
    });
    const set = createLspToolset({
      command: 'mock',
      workspace: '/tmp/ws',
      spawner: handle.spawner as unknown as typeof nodeSpawn,
      requestTimeoutMs: 500,
    });
    const refs = set.tools.find((t) => t.name === 'lsp_references')!;
    const r = await refs.execute({ path: 'a.ts', line: 0, character: 0 });
    expect(r.kind).toBe('success');
    if (r.kind === 'success') {
      const data = r.data as { locations: unknown[] };
      expect(data.locations).toHaveLength(200);
    }
    await set.dispose();
  });

  it('returns a structured error when the LSP request fails', async () => {
    const handle = createMockLspSpawner((req) => {
      if (req.method === 'initialize') return { capabilities: {} };
      return { error: { code: -32602, message: 'bad position' } };
    });
    const set = createLspToolset({
      command: 'mock',
      workspace: '/tmp/ws',
      spawner: handle.spawner as unknown as typeof nodeSpawn,
      requestTimeoutMs: 500,
    });
    const def = set.tools.find((t) => t.name === 'lsp_definition')!;
    const r = await def.execute({ path: 'a.ts', line: 0, character: 0 });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.message).toContain('lsp_definition failed');
    await set.dispose();
  });

  it('dispose is idempotent', async () => {
    const handle = createMockLspSpawner(() => ({ capabilities: {} }));
    const set = createLspToolset({
      command: 'mock',
      workspace: '/tmp/ws',
      spawner: handle.spawner as unknown as typeof nodeSpawn,
    });
    await set.dispose();
    await expect(set.dispose()).resolves.toBeUndefined();
  });
});
