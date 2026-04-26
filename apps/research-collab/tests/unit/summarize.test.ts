import { describe, expect, it, vi } from 'vitest';

import type { AgentAdapter, ChatParams, ChatResponse } from 'harness-one/core';

import { createAdapterSummarizer } from '../../src/tools/summarize.js';

function makeAdapter(handler: (p: ChatParams) => ChatResponse): AgentAdapter {
  return {
    name: 'test',
    async chat(params: ChatParams) {
      return handler(params);
    },
  };
}

describe('createAdapterSummarizer', () => {
  it('returns the assistant content trimmed and the usage', async () => {
    const adapter = makeAdapter(() => ({
      message: { role: 'assistant', content: '  Two-sentence summary.  ' },
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const sum = createAdapterSummarizer(adapter);
    const out = await sum.summarize({ subQuestion: 'q', url: 'https://x', content: 'page text' });
    expect(out.summary).toBe('Two-sentence summary.');
    expect(out.usage.outputTokens).toBe(5);
  });

  it('clamps the maxSentences to the supported range', async () => {
    const captured: ChatParams[] = [];
    const adapter = makeAdapter((p) => {
      captured.push(p);
      return { message: { role: 'assistant', content: 'ok' }, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const sum = createAdapterSummarizer(adapter);
    await sum.summarize({ subQuestion: 'q', url: 'https://x', content: 't', maxSentences: 0 });
    await sum.summarize({ subQuestion: 'q', url: 'https://x', content: 't', maxSentences: 99 });
    await sum.summarize({ subQuestion: 'q', url: 'https://x', content: 't', maxSentences: 1.5 });
    await sum.summarize({ subQuestion: 'q', url: 'https://x', content: 't' });
    const userMessages = captured.map((p) => p.messages.find((m) => m.role === 'user')?.content ?? '');
    expect(userMessages[0]).toContain('Maximum sentences: 1');
    expect(userMessages[1]).toContain('Maximum sentences: 8');
    expect(userMessages[2]).toContain('Maximum sentences: 4');
    expect(userMessages[3]).toContain('Maximum sentences: 4');
  });

  it('forwards the abort signal', async () => {
    const adapter: AgentAdapter = {
      name: 'test',
      async chat(params) {
        expect(params.signal?.aborted).toBe(true);
        return { message: { role: 'assistant', content: '' }, usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const sum = createAdapterSummarizer(adapter);
    const ctrl = new AbortController();
    ctrl.abort();
    await sum.summarize({ subQuestion: 'q', url: 'https://x', content: 't', signal: ctrl.signal });
  });

  it('uses an empty assistant body when the adapter returns no content', async () => {
    const adapter = makeAdapter(() => ({
      message: { role: 'assistant', content: '' },
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const sum = createAdapterSummarizer(adapter);
    const out = await sum.summarize({ subQuestion: 'q', url: 'https://x', content: 't' });
    expect(out.summary).toBe('');
  });

  it('passes a chatParams without signal when none provided', async () => {
    const captured: ChatParams[] = [];
    const adapter = makeAdapter((p) => {
      captured.push(p);
      return { message: { role: 'assistant', content: 'x' }, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const sum = createAdapterSummarizer(adapter);
    await sum.summarize({ subQuestion: 'q', url: 'https://x', content: 't' });
    expect(captured[0]?.signal).toBeUndefined();
  });

  it('surfaces adapter errors', async () => {
    const adapter: AgentAdapter = {
      name: 'broken',
      chat: vi.fn(async () => {
        throw new Error('upstream-down');
      }),
    };
    const sum = createAdapterSummarizer(adapter);
    await expect(sum.summarize({ subQuestion: 'q', url: 'https://x', content: 't' })).rejects.toThrow(
      /upstream-down/,
    );
  });
});
