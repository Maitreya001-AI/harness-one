/**
 * Minimal LSP client.
 *
 * Speaks the JSON-RPC 2.0 + LSP framing (Content-Length-prefixed
 * messages over stdio) so we can drive `typescript-language-server`,
 * `pyright`, `gopls`, etc. without a full LSP framework dependency.
 *
 * Scope is intentionally tiny: `initialize`, `initialized`, generic
 * `request`, and `shutdown`. Higher-level helpers (`textDocument/
 * definition`, `references`) build on top.
 *
 * @module
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import { toFileUri } from 'harness-one/io';

export interface LspClientOptions {
  /** argv[0] for the LSP server (e.g. `'typescript-language-server'`). */
  readonly command: string;
  readonly args?: readonly string[];
  /** Workspace root (must already be a canonical absolute path). */
  readonly workspace: string;
  /** Per-request timeout. Default: 30 s. */
  readonly requestTimeoutMs?: number;
  /** Override `spawn` for tests. */
  readonly spawner?: typeof spawn;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export interface LspClient {
  initialize(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  shutdown(): Promise<void>;
  /** Convert a workspace-relative path to a `file://` URI. */
  uri(relativePath: string): string;
}

export function createLspClient(options: LspClientOptions): LspClient {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawner = options.spawner ?? spawn;
  const child: ChildProcessWithoutNullStreams = spawner(
    options.command,
    [...(options.args ?? [])],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let initialized = false;
  let shuttingDown = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });

  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const len = Number(lengthMatch[1]);
      if (buffer.length < headerEnd + 4 + len) break;
      const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      buffer = buffer.slice(headerEnd + 4 + len);
      try {
        const parsed = JSON.parse(body) as {
          id?: number;
          result?: unknown;
          error?: { message?: string; code?: number };
        };
        if (typeof parsed.id === 'number') {
          const slot = pending.get(parsed.id);
          if (slot) {
            pending.delete(parsed.id);
            clearTimeout(slot.timer);
            if (parsed.error) {
              slot.reject(
                new HarnessError(
                  `LSP error ${parsed.error.code ?? '?'}: ${parsed.error.message ?? 'unknown'}`,
                  HarnessErrorCode.ADAPTER_ERROR,
                  'Inspect the LSP server logs',
                ),
              );
            } else {
              slot.resolve(parsed.result);
            }
          }
        }
      } catch {
        /* ignore malformed body — LSP server is responsible for framing correctness */
      }
    }
  });

  child.stderr.on('data', () => {
    /* swallow — server diagnostics flood stderr otherwise */
  });

  child.once('error', (err) => {
    for (const slot of pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(err);
    }
    pending.clear();
  });
  child.once('exit', () => {
    if (shuttingDown) return;
    for (const slot of pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(
        new HarnessError(
          'LSP server exited unexpectedly',
          HarnessErrorCode.ADAPTER_UNAVAILABLE,
          'Restart the agent or check that the language server binary is healthy',
        ),
      );
    }
    pending.clear();
  });

  function send(payload: Record<string, unknown>): void {
    const json = JSON.stringify(payload);
    const headers = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
    child.stdin.write(headers + json);
  }

  function uri(relativePath: string): string {
    // Cross-platform `file://` URI construction lives in harness-one/io
    // — see HARNESS_LOG HC-019 for the Windows backslash-in-URI bug
    // that motivated the centralised primitive.
    return toFileUri(options.workspace, relativePath);
  }

  async function request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new HarnessError(
            `LSP request "${method}" timed out after ${requestTimeoutMs}ms`,
            HarnessErrorCode.CORE_TIMEOUT,
            'Increase requestTimeoutMs or simplify the request',
          ),
        );
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      send({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
    });
  }

  function notify(method: string, params?: unknown): void {
    send({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) });
  }

  async function initialize(): Promise<void> {
    if (initialized) return;
    await request('initialize', {
      processId: process.pid,
      rootUri: uri('.'),
      capabilities: {},
      workspaceFolders: [{ uri: uri('.'), name: 'workspace' }],
    });
    notify('initialized', {});
    initialized = true;
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    try {
      await request('shutdown').catch(() => undefined);
      notify('exit');
    } finally {
      child.stdin.end();
      // Bound the wait — some servers refuse to exit cleanly.
      await Promise.race([
        exitPromise,
        new Promise<void>((r) => setTimeout(r, 1_000).unref?.()),
      ]);
      if (!child.killed) child.kill('SIGTERM');
    }
  }

  return { initialize, request, notify, shutdown, uri };
}
