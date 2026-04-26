import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCodingAgent } from '../../src/agent/index.js';
import { createMockAdapter } from './mock-adapter.js';

let workspace: string;
let checkpointDir: string;

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-int-ws-')));
  checkpointDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-int-cp-')));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(checkpointDir, { recursive: true, force: true });
});

describe('createCodingAgent + runTask', () => {
  it('runs a plan-only task to completion without invoking tools', async () => {
    const adapter = createMockAdapter([{ text: 'noop' }]);
    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      approval: 'auto',
    });
    const r = await agent.runTask({ prompt: 'just plan it', planOnly: true });
    expect(r.reason).toBe('completed');
    expect(r.state).toBe('planning');
    expect(r.changedFiles).toEqual([]);
    expect(adapter.captured).toEqual([]); // never asked the LLM
    expect((await agent.listCheckpoints()).length).toBe(1);
    await agent.shutdown();
  });

  it('drives the full state machine to done with a write_file tool call', async () => {
    await fs.writeFile(path.join(workspace, 'hello.txt'), 'old');

    const adapter = createMockAdapter([
      // turn 1: ask to write_file
      {
        toolCalls: [
          {
            id: 'tc1',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'hello.txt', content: 'new' }),
          },
        ],
      },
      // turn 2: emit final summary, no more tool calls
      { text: 'I rewrote hello.txt to "new".' },
    ]);

    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      approval: 'auto',
    });
    const r = await agent.runTask({ prompt: 'replace hello.txt content with new' });
    expect(r.reason).toBe('completed');
    expect(r.state).toBe('done');
    expect(r.changedFiles).toEqual(['hello.txt']);
    expect(await fs.readFile(path.join(workspace, 'hello.txt'), 'utf8')).toBe('new');
    expect(r.summary).toContain('rewrote hello.txt');
    await agent.shutdown();
  });

  it('aborts cleanly when iteration budget is exhausted', async () => {
    const turns = Array.from({ length: 10 }, () => ({
      toolCalls: [
        {
          id: `tc${Math.random()}`,
          name: 'list_dir',
          arguments: JSON.stringify({ path: '.' }),
        },
      ],
    }));
    const adapter = createMockAdapter(turns);

    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      approval: 'auto',
      budget: { iterations: 2 },
    });
    const r = await agent.runTask({ prompt: 'loop forever' });
    expect(r.iterations).toBeLessThanOrEqual(3);
    expect(['budget', 'completed']).toContain(r.reason);
    await agent.shutdown();
  });

  it('honors --resume by loading the prior checkpoint', async () => {
    const adapter1 = createMockAdapter([{ text: 'step 1 done' }]);
    const agent1 = await createCodingAgent({
      adapter: adapter1,
      workspace,
      checkpointDir,
      approval: 'auto',
    });
    const r1 = await agent1.runTask({ prompt: 'first', planOnly: true });
    await agent1.shutdown();

    const adapter2 = createMockAdapter([{ text: 'step 2 done' }]);
    const agent2 = await createCodingAgent({
      adapter: adapter2,
      workspace,
      checkpointDir,
      approval: 'auto',
    });
    const r2 = await agent2.runTask({
      prompt: 'will be overridden by resume',
      resumeTaskId: r1.taskId,
    });
    expect(r2.taskId).toBe(r1.taskId);
    await agent2.shutdown();
  });

  it('rejects --resume when checkpoint missing', async () => {
    const adapter = createMockAdapter([]);
    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      approval: 'auto',
    });
    await expect(
      agent.runTask({ prompt: 'noop', resumeTaskId: 'task_does_not_exist' }),
    ).rejects.toThrow();
    await agent.shutdown();
  });

  it('respects external AbortSignal', async () => {
    const adapter = createMockAdapter([
      {
        toolCalls: [
          {
            id: 'tc1',
            name: 'list_dir',
            arguments: JSON.stringify({ path: '.' }),
          },
        ],
      },
      { text: 'done' },
    ]);
    const ctrl = new AbortController();
    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      approval: 'auto',
    });
    ctrl.abort();
    const r = await agent.runTask({ prompt: 'p', signal: ctrl.signal });
    // either aborted-on-entry or runs once and aborts mid-stream — both
    // legal end states; only `completed` would be wrong.
    expect(['aborted', 'budget', 'error']).toContain(r.reason);
    await agent.shutdown();
  });
});
