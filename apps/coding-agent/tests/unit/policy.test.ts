import { describe, expect, it } from 'vitest';

import {
  createCodingGuardrails,
  createDangerousCommandTextGuardrail,
  createSecretPathScrubGuardrail,
} from '../../src/guardrails/policy.js';

describe('createDangerousCommandTextGuardrail', () => {
  it('blocks rm -rf / mention', async () => {
    const g = createDangerousCommandTextGuardrail();
    const v = await g({ content: "Sure, I'll just run rm -rf / to clean up" });
    expect(v.action).toBe('block');
  });

  it('blocks sudo escalation', async () => {
    const g = createDangerousCommandTextGuardrail();
    const v = await g({ content: 'we should sudo apt install foo' });
    expect(v.action).toBe('block');
  });

  it('allows benign content', async () => {
    const g = createDangerousCommandTextGuardrail();
    const v = await g({ content: 'Look at src/utils/parse.ts and rerun pnpm test' });
    expect(v.action).toBe('allow');
  });
});

describe('createSecretPathScrubGuardrail', () => {
  it('rewrites .env mention into redacted token', async () => {
    const g = createSecretPathScrubGuardrail();
    const v = await g({ content: 'check .env for ANTHROPIC_API_KEY' });
    expect(v.action).toBe('modify');
    if (v.action === 'modify') {
      expect(v.modified).toContain('<redacted-secret-path>');
    }
  });

  it('rewrites id_rsa mention', async () => {
    const g = createSecretPathScrubGuardrail();
    const v = await g({ content: 'cat ~/.ssh/id_rsa' });
    expect(v.action).toBe('modify');
  });

  it('allows clean content', async () => {
    const g = createSecretPathScrubGuardrail();
    const v = await g({ content: 'review src/index.ts and run tests' });
    expect(v.action).toBe('allow');
  });
});

describe('createCodingGuardrails', () => {
  it('returns input + output pipelines that block dangerous mentions', async () => {
    const { input, output } = createCodingGuardrails();
    const inputResult = await input.runInput({
      content: 'rm -rf / now',
    });
    expect(inputResult.passed).toBe(false);

    const outputResult = await output.runOutput({
      content: 'see .env for the api key',
    });
    expect(outputResult.passed).toBe(true); // modify, not block
    expect(outputResult.modifiedContent).toContain('<redacted-secret-path>');
  });

  it('passes clean content end-to-end', async () => {
    const { input, output } = createCodingGuardrails();
    expect((await input.runInput({ content: 'fix parse.ts' })).passed).toBe(true);
    expect((await output.runOutput({ content: 'rewrote parse.ts' })).passed).toBe(true);
  });
});
