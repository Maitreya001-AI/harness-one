import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createJsonlTraceExporter,
  defaultTraceDir,
} from '../../src/observability/jsonl-exporter.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-jsonl-')));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('defaultTraceDir', () => {
  it('points under .harness-coding/traces', () => {
    expect(defaultTraceDir()).toContain('.harness-coding');
    expect(defaultTraceDir()).toContain('traces');
  });
});

describe('createJsonlTraceExporter', () => {
  it('writes one line per trace + span into <id>.jsonl', async () => {
    const exporter = createJsonlTraceExporter({ directory: dir, now: () => 42 });
    await exporter.exportTrace({
      id: 'trace-1',
      name: 'task',
      startTime: 0,
      userMetadata: {},
      systemMetadata: {},
      spans: [],
      status: 'completed',
    });
    await exporter.exportSpan({
      id: 'span-1',
      traceId: 'trace-1',
      name: 'iter-1',
      startTime: 0,
      attributes: {},
      events: [],
      status: 'completed',
    });
    const content = await fs.readFile(path.join(dir, 'trace-1.jsonl'), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    const row1 = JSON.parse(lines[0]);
    expect(row1.kind).toBe('trace');
    expect(row1.ts).toBe(42);
    const row2 = JSON.parse(lines[1]);
    expect(row2.kind).toBe('span');
  });

  it('sanitises trace ids that contain path separators', async () => {
    const exporter = createJsonlTraceExporter({ directory: dir });
    await exporter.exportTrace({
      id: '../escape/from/here',
      name: 'task',
      startTime: 0,
      userMetadata: {},
      systemMetadata: {},
      spans: [],
      status: 'completed',
    });
    const entries = await fs.readdir(dir);
    expect(entries.length).toBe(1);
    expect(entries[0]).not.toContain('..');
    expect(entries[0]).not.toContain('/');
  });

  it('isHealthy returns false until initialize() is called', async () => {
    const exporter = createJsonlTraceExporter({ directory: dir });
    expect(exporter.isHealthy?.()).toBe(false);
    await exporter.initialize?.();
    expect(exporter.isHealthy?.()).toBe(true);
  });

  it('flush is a no-op (resolves)', async () => {
    const exporter = createJsonlTraceExporter({ directory: dir });
    await expect(exporter.flush()).resolves.toBeUndefined();
  });
});
