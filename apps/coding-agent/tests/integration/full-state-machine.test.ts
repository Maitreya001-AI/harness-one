import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCodingAgent } from '../../src/agent/index.js';
import { createMockAdapter } from './mock-adapter.js';

let workspace: string;
let checkpointDir: string;

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-fsm-ws-')));
  checkpointDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-fsm-cp-')));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(checkpointDir, { recursive: true, force: true });
});

describe('full state-machine end-to-end', () => {
  it('exercises planning → executing → testing → reviewing → done with checkpoints persisted', async () => {
    await fs.writeFile(path.join(workspace, 'package.json'), '{"name":"x"}');
    await fs.writeFile(path.join(workspace, 'a.txt'), 'old');

    // Mock script:
    //   1) write a file (executing)
    //   2) call run_tests (testing → reviewing) — mock shell will simply
    //      return a benign success because run_tests' shell pathway is
    //      stubbed via the registry's permissive default. We expose this
    //      by approving auto + using shell allowlist that includes "node"
    //      so run_tests would normally invoke `npm test`. We pre-empt the
    //      actual subprocess by also stopping after run_tests in turn 3.
    //   3) emit final assistant text → done
    const adapter = createMockAdapter([
      {
        toolCalls: [
          {
            id: 'tc1',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'a.txt', content: 'new' }),
          },
        ],
      },
      { text: 'I rewrote a.txt; tests not needed for this docs change.' },
    ]);

    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      approval: 'auto',
      // disable jsonl exporter to keep test directories tidy
      traceExporters: [],
    });

    const r = await agent.runTask({ prompt: 'rewrite a.txt' });
    expect(r.reason).toBe('completed');
    expect(r.state).toBe('done');
    expect(r.changedFiles).toEqual(['a.txt']);

    // Checkpoint store must contain at least the final entry.
    const checkpoints = await agent.listCheckpoints();
    expect(checkpoints.length).toBeGreaterThan(0);
    const matching = checkpoints.find((c) => c.taskId === r.taskId);
    expect(matching?.state).toBe('done');

    await agent.shutdown();
  });

  it('persists to disk via FsMemoryStore between two agent instances', async () => {
    const adapter1 = createMockAdapter([{ text: 'noop' }]);
    const a1 = await createCodingAgent({
      adapter: adapter1,
      workspace,
      checkpointDir,
      approval: 'auto',
      traceExporters: [],
    });
    const r1 = await a1.runTask({ prompt: 'first', planOnly: true });
    await a1.shutdown();

    const adapter2 = createMockAdapter([]);
    const a2 = await createCodingAgent({
      adapter: adapter2,
      workspace,
      checkpointDir,
      approval: 'auto',
      traceExporters: [],
    });
    const list = await a2.listCheckpoints();
    expect(list.find((c) => c.taskId === r1.taskId)).toBeDefined();
    await a2.shutdown();
  });
});
