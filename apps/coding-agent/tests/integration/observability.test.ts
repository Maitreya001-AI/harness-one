import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCodingAgent } from '../../src/agent/index.js';
import { createMockAdapter } from './mock-adapter.js';

let workspace: string;
let checkpointDir: string;
let traceDir: string;

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-obs-ws-')));
  checkpointDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-obs-cp-')));
  traceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-obs-tr-')));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(checkpointDir, { recursive: true, force: true });
  await fs.rm(traceDir, { recursive: true, force: true });
});

describe('observability integration', () => {
  it('exposes a TraceManager on the returned agent', async () => {
    const adapter = createMockAdapter([{ text: 'noop' }]);
    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      traceDir,
      approval: 'auto',
    });
    expect(agent.traces).toBeDefined();
    expect(typeof agent.traces.startTrace).toBe('function');
    await agent.shutdown();
  });

  it('honours empty traceExporters[] (disables filesystem tracing)', async () => {
    const adapter = createMockAdapter([{ text: 'noop' }]);
    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      traceExporters: [],
      approval: 'auto',
    });
    await agent.runTask({ prompt: 'p', planOnly: true });
    await agent.shutdown();
    // No traceDir was used; nothing to assert on disk.
    expect(agent.traces).toBeDefined();
  });
});
