/**
 * Tests for `guardrail-runner.ts` — the round-3 extraction that centralises
 * the input / output / tool-output guardrail invocation shapes.
 */
import { describe, it, expect } from 'vitest';
import {
  runInputGuardrail,
  runOutputGuardrail,
  runToolOutputGuardrail,
} from '../guardrail-runner.js';
import type { GuardrailPipeline, PipelineResult } from '../guardrail-port.js';
import type { Message } from '../types.js';

function makePipeline(verdict: {
  input?: PipelineResult;
  output?: PipelineResult;
  tool?: PipelineResult;
}): GuardrailPipeline {
  const base: PipelineResult = {
    passed: true,
    results: [],
    verdict: { action: 'allow', reason: '' },
  };
  return {
    runInput: async () => verdict.input ?? base,
    runOutput: async () => verdict.output ?? base,
    runToolOutput: async () => verdict.tool ?? base,
    runRagContext: async () => base,
  } as unknown as GuardrailPipeline;
}

function makeEvent(name: string, reason: string, direction: 'input' | 'output') {
  return {
    guardrail: name,
    direction,
    verdict: { action: 'block' as const, reason },
    latencyMs: 0,
    passed: false,
  };
}

describe('runInputGuardrail', () => {
  it('passes when no pipeline', async () => {
    const out = await runInputGuardrail([], undefined);
    expect(out.kind).toBe('passed');
  });

  it('passes when no user message present', async () => {
    const systemOnly: Message[] = [{ role: 'system', content: 'sys' }];
    const pipe = makePipeline({
      input: { passed: false, results: [], verdict: { action: 'block', reason: 'unused' } },
    });
    const out = await runInputGuardrail(systemOnly, pipe);
    expect(out.kind).toBe('passed');
  });

  it('blocks with matching guardrail + error events', async () => {
    const convo: Message[] = [{ role: 'user', content: 'hi' }];
    const pipe = makePipeline({
      input: {
        passed: false,
        verdict: { action: 'block', reason: 'bad vibes' },
        results: [makeEvent('banned-words', 'bad vibes', 'input')],
      },
    });
    const out = await runInputGuardrail(convo, pipe);
    if (out.kind !== 'blocked') throw new Error('expected blocked');
    expect(out.guardrailEvent.type).toBe('guardrail_blocked');
    expect(out.guardrailEvent.phase).toBe('input');
    expect(out.guardrailEvent.guardName).toBe('banned-words');
    expect(out.errorEvent.error.message).toContain('blocked input');
  });
});

describe('runOutputGuardrail', () => {
  it('passes when no pipeline', async () => {
    const out = await runOutputGuardrail('anything', undefined);
    expect(out.kind).toBe('passed');
  });

  it('blocks with output-phase event', async () => {
    const pipe = makePipeline({
      output: {
        passed: false,
        verdict: { action: 'block', reason: 'pii' },
        results: [makeEvent('pii-scrubber', 'pii', 'output')],
      },
    });
    const out = await runOutputGuardrail('contains ssn', pipe);
    if (out.kind !== 'blocked') throw new Error('expected blocked');
    expect(out.guardrailEvent.phase).toBe('output');
    expect(out.errorEvent.error.message).toContain('blocked output');
  });
});

describe('runToolOutputGuardrail', () => {
  it('passes when no pipeline', async () => {
    const out = await runToolOutputGuardrail('{}', 'tool', 'call-1', undefined);
    expect(out.kind).toBe('passed');
  });

  it('blocks with tool_output event + replacement content', async () => {
    const pipe = makePipeline({
      tool: {
        passed: false,
        verdict: { action: 'block', reason: 'leak' },
        results: [makeEvent('secret-scan', 'leak', 'output')],
      },
    });
    const out = await runToolOutputGuardrail('raw-output', 'db.query', 'call-2', pipe);
    if (out.kind !== 'blocked') throw new Error('expected blocked');
    expect(out.guardrailEvent.phase).toBe('tool_output');
    const details = out.guardrailEvent.details as {
      toolCallId: string;
      toolName?: string;
      reason: string;
    };
    expect(details.toolCallId).toBe('call-2');
    expect(details.toolName).toBe('db.query');
    const replaced = JSON.parse(out.replacementContent) as { error: string; reason: string };
    expect(replaced.reason).toBe('leak');
  });
});
