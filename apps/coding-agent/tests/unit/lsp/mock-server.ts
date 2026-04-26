/**
 * Synthetic LSP server-process double for tests.
 *
 * Returns a `child_process`-shaped object that the LSP client can drive
 * exactly like a real subprocess. The mock parses the same Content-Length
 * framed JSON-RPC messages and replies according to a programmable script.
 *
 * @module
 */

import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

/** Sentinel — return from `respondTo` to skip the reply (simulate server hang). */
export const NO_REPLY = Symbol('NO_REPLY');

type ResponseFor = (request: {
  id?: number;
  method: string;
  params?: unknown;
}) => unknown | { error: { code: number; message: string } } | typeof NO_REPLY | undefined;

export interface MockSpawnerHandle {
  spawner: (cmd: string, args: readonly string[]) => MockChild;
  /** Last child spawned. */
  child(): MockChild | undefined;
}

export interface MockChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid: number;
  killed: boolean;
  kill(signal?: string): boolean;
}

/** Build a fake spawner that produces a programmable LSP server. */
export function createMockLspSpawner(respondTo: ResponseFor): MockSpawnerHandle {
  let lastChild: MockChild | undefined;
  return {
    spawner: () => {
      const child = createMockChild(respondTo);
      lastChild = child;
      return child;
    },
    child: () => lastChild,
  };
}

function createMockChild(respondTo: ResponseFor): MockChild {
  const emitter = new EventEmitter() as MockChild;
  const stdoutStream = new Readable({ read() {} });
  const stderrStream = new Readable({ read() {} });

  let buffer = Buffer.alloc(0);
  const stdinStream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
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
            method: string;
            params?: unknown;
          };
          handle(parsed);
        } catch {
          /* ignore */
        }
      }
      cb();
    },
  });

  function handle(req: { id?: number; method: string; params?: unknown }): void {
    // Always invoke respondTo so the test can record every method, including
    // notifications like `exit` and `initialized`.
    const reply = respondTo(req);

    if (req.method === 'exit') {
      setImmediate(() => {
        emitter.killed = true;
        emitter.emit('exit', 0);
        stdoutStream.push(null);
        stderrStream.push(null);
      });
      return;
    }
    if (reply === NO_REPLY) return;
    if (typeof req.id !== 'number') return; // notification — no response expected
    const payload =
      reply !== undefined && reply !== null && typeof reply === 'object' && 'error' in (reply as object)
        ? { jsonrpc: '2.0', id: req.id, error: (reply as { error: unknown }).error }
        : { jsonrpc: '2.0', id: req.id, result: reply ?? null };
    const json = JSON.stringify(payload);
    const buf = Buffer.from(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    setImmediate(() => stdoutStream.push(buf));
  }

  emitter.stdin = stdinStream;
  emitter.stdout = stdoutStream;
  emitter.stderr = stderrStream;
  emitter.pid = 12345;
  emitter.killed = false;
  emitter.kill = (_signal?: string): boolean => {
    emitter.killed = true;
    setImmediate(() => emitter.emit('exit', 0));
    return true;
  };
  return emitter;
}
