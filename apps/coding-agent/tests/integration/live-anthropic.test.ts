/**
 * Live integration test against the real Anthropic SDK.
 *
 * Skipped automatically when `ANTHROPIC_API_KEY` is unset so CI without
 * a key still passes. Set `CODING_AGENT_LIVE=1` to opt in even when a
 * key is present (the bare key alone is not enough — we want explicit
 * intent to spend tokens).
 *
 * @module
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCodingAgent } from '../../src/agent/index.js';
import type { AgentAdapter } from 'harness-one/core';

const KEY = process.env['ANTHROPIC_API_KEY'];
const OPTED_IN = process.env['CODING_AGENT_LIVE'] === '1';
const LIVE = typeof KEY === 'string' && KEY.length > 0 && OPTED_IN;

describe.skipIf(!LIVE)('live Anthropic adapter (real API)', () => {
  let workspace: string;
  let checkpointDir: string;
  let traceDir: string;

  beforeAll(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-live-ws-')));
    checkpointDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-live-cp-')),
    );
    traceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-live-tr-')));
    await fs.writeFile(path.join(workspace, 'README.md'), '# fixture\nhello world\n');
  });

  afterAll(async () => {
    await Promise.all([
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(checkpointDir, { recursive: true, force: true }),
      fs.rm(traceDir, { recursive: true, force: true }),
    ]);
  });

  it('runs a tiny task end-to-end against the real model', async () => {
    const [{ default: Anthropic }, { createAnthropicAdapter }] = await Promise.all([
      import('@anthropic-ai/sdk'),
      import('@harness-one/anthropic'),
    ]);
    const client = new Anthropic({ apiKey: KEY });
    const adapter: AgentAdapter = createAnthropicAdapter({
      client,
      model: 'claude-haiku-4-5-20251001',
    });

    const agent = await createCodingAgent({
      adapter,
      workspace,
      checkpointDir,
      traceDir,
      approval: 'auto',
      // Live tests must be tightly capped — token + iteration + duration.
      budget: { tokens: 8_000, iterations: 4, durationMs: 60_000 },
      model: 'claude-haiku-4-5-20251001',
    });
    const r = await agent.runTask({
      prompt:
        'Read README.md in the workspace and summarise its single line in one sentence. Use only read_file.',
    });
    await agent.shutdown();

    expect(r.taskId).toBeDefined();
    expect(['completed', 'budget']).toContain(r.reason);
    expect(r.cost.tokens).toBeGreaterThan(0);
    if (r.reason === 'completed') {
      expect(r.summary.length).toBeGreaterThan(0);
    }
  }, 90_000);
});
