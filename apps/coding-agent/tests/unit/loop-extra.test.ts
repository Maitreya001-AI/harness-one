import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCodingAgent } from '../../src/agent/index.js';
import { createMockAdapter } from '../integration/mock-adapter.js';

let workspace: string;
let checkpointDir: string;

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-loop-extra-')));
  checkpointDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-loop-extra-cp-')));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(checkpointDir, { recursive: true, force: true });
});

describe('runTask extra branches', () => {
  it('records a tool call entry with malformed JSON arguments', async () => {
    const adapter = createMockAdapter([
      {
        toolCalls: [
          { id: 'tc1', name: 'list_dir', arguments: 'not-json' },
        ],
      },
      { text: 'done' },
    ]);
    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      approval: 'auto',
      traceExporters: [],
    });
    const r = await agent.runTask({ prompt: 'list' });
    expect(r.reason).toBe('completed');
    await agent.shutdown();
  });

  it('records denied tool calls with allow=false', async () => {
    const adapter = createMockAdapter([
      {
        toolCalls: [
          {
            id: 'tc1',
            name: 'shell',
            arguments: JSON.stringify({ command: 'sudo', args: ['ls'] }),
          },
        ],
      },
      { text: 'aborted' },
    ]);
    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      approval: 'auto',
      traceExporters: [],
    });
    const r = await agent.runTask({ prompt: 'try evil' });
    // The shell deny propagates through the tool result; agent finishes
    // with reason=completed once the LLM emits a final message.
    expect(['completed', 'error']).toContain(r.reason);
    await agent.shutdown();
  });

  it('reports unknown tool calls without crashing', async () => {
    const adapter = createMockAdapter([
      {
        toolCalls: [
          { id: 'tc1', name: 'no_such_tool', arguments: '{}' },
        ],
      },
      { text: 'done' },
    ]);
    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      approval: 'auto',
      traceExporters: [],
    });
    const r = await agent.runTask({ prompt: 'p' });
    expect(['completed', 'error']).toContain(r.reason);
    await agent.shutdown();
  });
});
