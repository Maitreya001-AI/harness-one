import { describe, expect, it } from 'vitest';

import type { ChatParams } from 'harness-one/core';

import { createMockAdapter, DEFAULT_SCRIPT } from '../../src/mock-adapter.js';
import { buildResearcherSystemPrompt } from '../../src/prompts/researcher.js';
import { buildSpecialistSystemPrompt, buildSpecialistUserTurn } from '../../src/prompts/specialist.js';
import { buildCoordinatorSystemPrompt } from '../../src/prompts/coordinator.js';

function userMessage(content: string): ChatParams['messages'][number] {
  return { role: 'user', content };
}

function systemMessage(content: string): ChatParams['messages'][number] {
  return { role: 'system', content };
}

function toolMessage(): ChatParams['messages'][number] {
  return { role: 'tool', toolCallId: 'mock-tc', content: '{}' };
}

describe('createMockAdapter', () => {
  const adapter = createMockAdapter();

  it('returns researcher JSON when system prompt matches', async () => {
    const res = await adapter.chat({
      messages: [systemMessage(buildResearcherSystemPrompt()), userMessage('decompose: q')],
    });
    const parsed = JSON.parse(res.message.content);
    expect(parsed.subQuestions).toHaveLength(DEFAULT_SCRIPT.subQuestions.length);
  });

  it('issues web_fetch tool calls on the first specialist turn', async () => {
    const sub = DEFAULT_SCRIPT.subQuestions[0]!;
    const res = await adapter.chat({
      messages: [
        systemMessage(buildSpecialistSystemPrompt()),
        userMessage(buildSpecialistUserTurn(sub, 'orig')),
      ],
    });
    expect(res.message.role).toBe('assistant');
    expect(res.message.content).toBe('');
    if (res.message.role === 'assistant') {
      expect(res.message.toolCalls?.length ?? 0).toBeGreaterThan(0);
      expect(res.message.toolCalls?.[0]?.name).toBe('web_fetch');
    }
  });

  it('returns specialist JSON on the second turn (after a tool message)', async () => {
    const sub = DEFAULT_SCRIPT.subQuestions[0]!;
    const res = await adapter.chat({
      messages: [
        systemMessage(buildSpecialistSystemPrompt()),
        userMessage(buildSpecialistUserTurn(sub, 'orig')),
        { role: 'assistant', content: '' },
        toolMessage(),
      ],
    });
    const parsed = JSON.parse(res.message.content);
    expect(parsed.confidence).toBe(DEFAULT_SCRIPT.specialistAnswers[0]?.confidence);
  });

  it('returns coordinator JSON', async () => {
    const res = await adapter.chat({
      messages: [systemMessage(buildCoordinatorSystemPrompt()), userMessage('synthesise')],
    });
    const parsed = JSON.parse(res.message.content);
    expect(parsed.summary).toBe(DEFAULT_SCRIPT.report.summary);
  });

  it('streams the same content', async () => {
    const chunks: string[] = [];
    const stream = adapter.stream?.({
      messages: [systemMessage(buildResearcherSystemPrompt()), userMessage('q')],
    });
    if (!stream) throw new Error('stream not provided');
    for await (const chunk of stream) {
      if (chunk.text) chunks.push(chunk.text);
    }
    const joined = chunks.join('');
    const parsed = JSON.parse(joined);
    expect(parsed.subQuestions).toHaveLength(DEFAULT_SCRIPT.subQuestions.length);
  });

  it('falls back to researcher reply when system role is missing', async () => {
    const res = await adapter.chat({ messages: [userMessage('decompose me')] });
    const parsed = JSON.parse(res.message.content);
    expect(parsed.subQuestions).toBeDefined();
  });

it('extracts subquestion index defaulting to 1 when missing (after tool turn)', async () => {
    const res = await adapter.chat({
      messages: [
        systemMessage(buildSpecialistSystemPrompt()),
        userMessage('no index here'),
        { role: 'assistant', content: '' },
        toolMessage(),
      ],
    });
    const parsed = JSON.parse(res.message.content);
    expect(parsed.confidence).toBe(DEFAULT_SCRIPT.specialistAnswers[0]?.confidence);
  });

  it('returns low-confidence stub when no script answer matches (no tool turn needed)', async () => {
    const res = await adapter.chat({
      messages: [
        systemMessage(buildSpecialistSystemPrompt()),
        userMessage('Subquestion #99: do something'),
      ],
    });
    const parsed = JSON.parse(res.message.content);
    expect(parsed.confidence).toBe('low');
  });

  it('honours a script override', async () => {
    const adapter2 = createMockAdapter({
      script: {
        subQuestions: [{ index: 1, text: 'q1?', rationale: 'r' }],
        specialistAnswers: [],
        report: {
          summary: 'overridden',
          markdown: 'md',
          citations: [],
        },
      },
    });
    const res = await adapter2.chat({
      messages: [systemMessage(buildCoordinatorSystemPrompt()), userMessage('q')],
    });
    const parsed = JSON.parse(res.message.content);
    expect(parsed.summary).toBe('overridden');
  });
});
