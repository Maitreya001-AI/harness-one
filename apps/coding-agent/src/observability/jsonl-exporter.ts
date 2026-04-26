/**
 * Filesystem JSON-Lines trace exporter.
 *
 * Writes one line per trace + one line per span into
 * `<dir>/<traceId>.jsonl`. Designed for offline post-mortem inspection of
 * what the coding agent did during a long task. Keeps zero new
 * dependencies — appendFile + JSON.stringify is enough.
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Span, Trace, TraceExporter } from 'harness-one/observe';

export interface JsonlExporterOptions {
  /** Output directory; defaults to `~/.harness-coding/traces`. */
  readonly directory?: string;
  /** Override `Date.now()` for tests. */
  readonly now?: () => number;
}

export function defaultTraceDir(): string {
  return path.join(os.homedir(), '.harness-coding', 'traces');
}

export function createJsonlTraceExporter(options?: JsonlExporterOptions): TraceExporter {
  const directory = options?.directory ?? defaultTraceDir();
  const now = options?.now ?? Date.now;
  let initialized = false;

  async function ensureDir(): Promise<void> {
    if (initialized) return;
    await fs.mkdir(directory, { recursive: true });
    initialized = true;
  }

  function pathFor(traceId: string): string {
    return path.join(directory, `${sanitize(traceId)}.jsonl`);
  }

  async function append(traceId: string, line: Record<string, unknown>): Promise<void> {
    await ensureDir();
    await fs.appendFile(pathFor(traceId), `${JSON.stringify({ ...line, ts: now() })}\n`, 'utf8');
  }

  return {
    name: 'coding-agent.jsonl',
    async exportTrace(trace: Trace): Promise<void> {
      await append(trace.id, { kind: 'trace', trace });
    },
    async exportSpan(span: Span): Promise<void> {
      await append(span.traceId, { kind: 'span', span });
    },
    async flush(): Promise<void> {
      // appendFile is unbuffered — nothing to flush.
    },
    async initialize(): Promise<void> {
      await ensureDir();
    },
    isHealthy(): boolean {
      return initialized;
    },
  };
}

/**
 * Strip filesystem-unsafe characters from a trace id.
 *
 * Replaces path separators, drops leading dots so the sanitised name
 * cannot start with `.` / `..` (and therefore cannot be an attempt to
 * escape via relative-path semantics), and clips to 200 chars.
 */
function sanitize(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  return cleaned.replace(/^_+/, '') || 'trace';
}
