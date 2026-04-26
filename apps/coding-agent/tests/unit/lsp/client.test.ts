import { describe, expect, it } from 'vitest';
import type { spawn as nodeSpawn } from 'node:child_process';

import { createLspClient } from '../../../src/tools/lsp/client.js';
import { NO_REPLY, createMockLspSpawner } from './mock-server.js';

describe('LspClient', () => {
  it('initialize → request → shutdown round-trips through a mock LSP server', async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const handle = createMockLspSpawner((req) => {
      calls.push({ method: req.method, params: req.params });
      if (req.method === 'initialize') return { capabilities: {} };
      if (req.method === 'shutdown') return null;
      if (req.method === 'textDocument/definition') {
        return {
          uri: 'file:///tmp/ws/a.ts',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
        };
      }
      return null;
    });

    const client = createLspClient({
      command: 'mock',
      workspace: '/tmp/ws',
      spawner: handle.spawner as unknown as typeof nodeSpawn,
      requestTimeoutMs: 1_000,
    });
    await client.initialize();
    const def = await client.request('textDocument/definition', {
      textDocument: { uri: client.uri('a.ts') },
      position: { line: 0, character: 0 },
    });
    expect(def).toMatchObject({
      uri: 'file:///tmp/ws/a.ts',
      range: { start: { line: 0, character: 0 } },
    });
    await client.shutdown();
    expect(calls.map((c) => c.method)).toEqual([
      'initialize',
      'initialized',
      'textDocument/definition',
      'shutdown',
      'exit',
    ]);
  });

  it('rejects with a HarnessError on LSP error responses', async () => {
    const handle = createMockLspSpawner((req) => {
      if (req.method === 'initialize') return { capabilities: {} };
      return { error: { code: -32602, message: 'bad params' } };
    });
    const client = createLspClient({
      command: 'mock',
      workspace: '/tmp/ws',
      spawner: handle.spawner as unknown as typeof nodeSpawn,
      requestTimeoutMs: 1_000,
    });
    await client.initialize();
    await expect(client.request('textDocument/foo')).rejects.toThrow(/bad params/);
    await client.shutdown();
  });

  it('times out when the server never responds', async () => {
    const handle = createMockLspSpawner((req) => {
      if (req.method === 'initialize') return { capabilities: {} };
      return NO_REPLY;
    });
    const client = createLspClient({
      command: 'mock',
      workspace: '/tmp/ws',
      spawner: handle.spawner as unknown as typeof nodeSpawn,
      requestTimeoutMs: 50,
    });
    await client.initialize();
    await expect(client.request('textDocument/hover')).rejects.toThrow(/timed out/);
    await client.shutdown();
  });

  it('builds workspace-relative file URIs', async () => {
    const handle = createMockLspSpawner(() => null);
    const client = createLspClient({
      command: 'mock',
      workspace: '/tmp/ws',
      spawner: handle.spawner as unknown as typeof nodeSpawn,
      requestTimeoutMs: 200,
    });
    expect(client.uri('a.ts')).toBe('file:///tmp/ws/a.ts');
    expect(client.uri('/tmp/ws/sub/b.ts')).toBe('file:///tmp/ws/sub/b.ts');
    await client.shutdown();
  });
});
