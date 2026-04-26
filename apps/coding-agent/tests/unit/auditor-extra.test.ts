import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

import { createAuditor } from '../../src/guardrails/auditor.js';
import type { ApprovalRequest } from '../../src/agent/types.js';

describe('auditor edge cases', () => {
  it('falls back to deny when stdin closes mid-prompt', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    const a = createAuditor({ mode: 'always-ask', input, output });
    const decision = a.decide({
      toolName: 'shell',
      arguments: { command: 'pnpm', args: [] },
      reason: 'r',
    });
    setTimeout(() => input.destroy(), 5);
    const d = await decision;
    expect(d.allow).toBe(false);
  });

  it('treats non-newline-terminated yes input on close as allow', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    const a = createAuditor({ mode: 'always-ask', input, output });
    const decision = a.decide({
      toolName: 'shell',
      arguments: { command: 'pnpm', args: [] },
      reason: 'r',
    });
    setTimeout(() => {
      input.write('y');
      setTimeout(() => input.end(), 5);
    }, 5);
    const d = await decision;
    expect(d.allow).toBe(true);
  });

  it('non-shell tools skip the command policy pre-flight', async () => {
    const a = createAuditor({ mode: 'auto' });
    const req: ApprovalRequest = {
      toolName: 'write_file',
      arguments: { path: 'a.txt', content: 'x' },
      reason: 'r',
    };
    expect((await a.decide(req)).allow).toBe(true);
  });

  it('shell calls without a command field skip the policy', async () => {
    const a = createAuditor({ mode: 'auto' });
    const req: ApprovalRequest = {
      toolName: 'shell',
      arguments: {},
      reason: 'r',
    };
    expect((await a.decide(req)).allow).toBe(true);
  });
});
