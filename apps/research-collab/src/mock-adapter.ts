/**
 * Deterministic mock {@link AgentAdapter} for the research-collab pipeline.
 *
 * Returns hand-crafted responses keyed by the system-prompt prefix so the
 * three agents (Researcher / Specialist / Coordinator) each receive a sane
 * canned reply. Used by `RESEARCH_MOCK=1` runs and the integration tests.
 *
 * The mock never makes a network call and never spends real money — it's the
 * dogfood of dogfood, validating that the pipeline plumbing is correct
 * without depending on a live model.
 */

import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
  ToolCallRequest,
} from 'harness-one/core';

import type { Citation, ResearchReport, SpecialistAnswer, SubQuestion } from './types.js';

export interface MockAdapterScript {
  readonly subQuestions: readonly SubQuestion[];
  /**
   * Fixed Specialist responses keyed by `subQuestionIndex`. The mock
   * matches against the index referenced in the user message.
   */
  readonly specialistAnswers: readonly SpecialistAnswer[];
  readonly report: ResearchReport;
}

const DEFAULT_SCRIPT: MockAdapterScript = {
  subQuestions: [
    {
      index: 1,
      text: 'What is the primary goal of harness-one orchestration?',
      rationale: 'Frames the answer around the project mission.',
    },
    {
      index: 2,
      text: 'How does the orchestration subsystem expose handoffs?',
      rationale: 'Captures the public API surface relevant to multi-agent apps.',
    },
  ],
  specialistAnswers: [
    {
      subQuestionIndex: 1,
      answer:
        'Harness-one orchestration provides primitives (registry, handoff, shared context) so apps can compose multi-agent workflows without a graph DSL.',
      citations: [
        {
          url: 'https://example.com/harness-one-orchestration',
          title: 'Harness-one orchestration overview',
          excerpt: 'Orchestration exposes registry, handoff, and shared context.',
        },
      ],
      confidence: 'medium',
    },
    {
      subQuestionIndex: 2,
      answer:
        '`createHandoff` wraps any MessageTransport (the orchestrator satisfies it) and emits HandoffReceipts the consumer can audit and verify.',
      citations: [
        {
          url: 'https://example.com/handoff-api',
          title: 'createHandoff API',
          excerpt: 'createHandoff layers structured handoff semantics on top of any MessageTransport.',
        },
      ],
      confidence: 'high',
    },
  ],
  report: {
    summary:
      'Harness-one orchestration provides registry + handoff + shared-context primitives so multi-agent apps stay composable without an explicit DSL.',
    markdown: [
      '## Summary',
      '',
      'Harness-one orchestration ships registry, handoff and shared-context primitives.',
      '',
      '## Detail',
      '',
      'Apps can register agents on `createOrchestrator`, dispatch handoffs via `createHandoff`, and inspect HandoffReceipts.',
      '',
      '## Sources',
      '',
      '- https://example.com/harness-one-orchestration',
      '- https://example.com/handoff-api',
      '',
    ].join('\n'),
    citations: [
      {
        url: 'https://example.com/harness-one-orchestration',
        title: 'Harness-one orchestration overview',
        excerpt: 'Orchestration exposes registry, handoff, and shared context.',
      },
      {
        url: 'https://example.com/handoff-api',
        title: 'createHandoff API',
        excerpt: 'createHandoff layers structured handoff semantics on top of any MessageTransport.',
      },
    ],
  },
};

export interface CreateMockAdapterOptions {
  /** Override the canned script (tests). Defaults to a small example. */
  readonly script?: MockAdapterScript;
  /** Per-call usage so cost tracking sees realistic numbers. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

const DEFAULT_USAGE = { inputTokens: 96, outputTokens: 256 };

export function createMockAdapter(options: CreateMockAdapterOptions = {}): AgentAdapter {
  const script = options.script ?? DEFAULT_SCRIPT;
  const usage = options.usage ?? DEFAULT_USAGE;

  /**
   * Specialist replies happen in TWO turns so the mock exercises the harness
   * tool path:
   *   - turn 1 (no `tool` messages yet) → emit a `web_fetch` toolCall for
   *     each citation URL the script will later quote, so the Specialist's
   *     `fetchedUrls` set actually contains them and the citation parser
   *     accepts the answer.
   *   - turn 2 (after harness has fed back tool results) → emit the JSON
   *     answer with citations.
   *
   * Researcher and Coordinator are single-turn — no tools.
   */
  function reply(params: ChatParams): { content: string; toolCalls?: ToolCallRequest[] } {
    const role = detectRole(params);
    switch (role) {
      case 'researcher':
        return { content: JSON.stringify({ subQuestions: script.subQuestions }) };
      case 'specialist': {
        const idx = extractSubQuestionIndex(params);
        const ans = script.specialistAnswers.find((a) => a.subQuestionIndex === idx);
        if (!ans) {
          return {
            content: JSON.stringify({
              answer: `No mock answer registered for subquestion #${idx}.`,
              citations: [] as Citation[],
              confidence: 'low',
            }),
          };
        }
        const hasToolMessage = params.messages.some((m) => m.role === 'tool');
        if (!hasToolMessage && ans.citations.length > 0) {
          // Turn 1 — fetch every citation URL so the Specialist tracker logs them.
          return {
            content: '',
            toolCalls: ans.citations.map((c, i) => ({
              id: `mock-fetch-${idx}-${i}`,
              name: 'web_fetch',
              arguments: JSON.stringify({ url: c.url }),
            })),
          };
        }
        return {
          content: JSON.stringify({
            answer: ans.answer,
            citations: ans.citations,
            confidence: ans.confidence,
          }),
        };
      }
      case 'coordinator':
        return {
          content: JSON.stringify({
            summary: script.report.summary,
            markdown: script.report.markdown,
            citations: script.report.citations,
          }),
        };
    }
  }

  return {
    name: 'research-collab:mock',
    async chat(params: ChatParams): Promise<ChatResponse> {
      const { content, toolCalls } = reply(params);
      return {
        message: {
          role: 'assistant',
          content,
          ...(toolCalls !== undefined && toolCalls.length > 0 && { toolCalls }),
        },
        usage,
      };
    },
    async *stream(params: ChatParams): AsyncGenerator<StreamChunk> {
      const { content, toolCalls } = reply(params);
      if (content.length > 0) {
        yield { type: 'text_delta', text: content };
      }
      if (toolCalls) {
        for (const tc of toolCalls) {
          yield { type: 'tool_call_delta', toolCall: tc };
        }
      }
      yield { type: 'done', usage };
    },
  };
}

type AgentTag = 'researcher' | 'specialist' | 'coordinator';

function detectRole(params: ChatParams): AgentTag {
  const system = params.messages.find((m) => m.role === 'system');
  const text = system?.content ?? '';
  if (text.includes('Researcher agent')) return 'researcher';
  if (text.includes('Specialist agent')) return 'specialist';
  if (text.includes('Coordinator agent')) return 'coordinator';
  // Fallback: assume researcher so a malformed prompt at least flows through.
  return 'researcher';
}

function extractSubQuestionIndex(params: ChatParams): number {
  const user = params.messages.find((m) => m.role === 'user');
  const match = /subquestion\s*#(\d+)/i.exec(user?.content ?? '');
  if (match && match[1]) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n)) return n;
  }
  return 1;
}

export { DEFAULT_SCRIPT };
