/**
 * Example · Codebase Q&A with RAG + fail-closed guardrails.
 *
 * Demonstrates the full RAG-to-answer pipeline with three production-grade
 * concerns wired in:
 *
 *   1. RAG retrieval (`harness-one/rag`) over a small file:line-indexed
 *      corpus.
 *   2. Fail-closed injection guardrails (`harness-one/guardrails`) running
 *      on every retrieved chunk before the reader sees it — the
 *      RAG-injection mitigation the README promises.
 *   3. AgentLoop with a mock reader (`harness-one/core` +
 *      `harness-one/testing`) that consumes retrieved chunks as system
 *      context and produces an assistant reply with citations.
 *
 * To run with a real provider, swap `createMockAdapter` for
 * `@harness-one/anthropic` or `@harness-one/openai` and provide the API
 * key.
 *
 *   pnpm tsx examples/codebase-qa.ts
 *
 * No peer SDK, no API key — this example runs in CI under
 * `examples:smoke`.
 */
import {
  createBasicParagraphChunking,
  createDocumentArrayLoader,
  createInMemoryRetriever,
} from 'harness-one/rag';
import type {
  Document,
  DocumentChunk,
  EmbedOptions,
  EmbeddingModel,
} from 'harness-one/rag';
import {
  createInjectionDetector,
  createPipeline,
  runInput,
} from 'harness-one/guardrails';
import { AgentLoop } from 'harness-one/core';
import type { Message } from 'harness-one/core';
import { createMockAdapter } from 'harness-one/testing';

interface Citation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly score: number;
}

interface AskResult {
  readonly question: string;
  readonly answer: string;
  readonly citations: readonly Citation[];
}

// ── 1. Corpus ───────────────────────────────────────────────────────────────
// Four short excerpts that look like file:line cites. In production this
// list is the output of a codebase indexer.
const CORPUS: readonly Document[] = [
  {
    id: 'docs/architecture/05-guardrails.md#L14',
    content:
      'Guardrail verdicts are fail-closed by default. A block verdict during the input hook '
      + 'aborts the AgentLoop before the adapter is called, emits a `guardrail_blocked` event, '
      + 'and prevents follow-up tool execution.',
    metadata: { file: 'docs/architecture/05-guardrails.md', line: 14 },
  },
  {
    id: 'packages/core/src/core/types.ts#L178',
    content:
      'StreamChunk has three types: text_delta, tool_call_delta, and done. Adapters must emit '
      + 'a final done chunk carrying TokenUsage or the loop treats the stream as truncated.',
    metadata: { file: 'packages/core/src/core/types.ts', line: 178 },
  },
  {
    id: 'docs/architecture/02-agent-loop.md#L42',
    content:
      'The AgentLoop treats provider errors as retryable by default with exponential backoff '
      + 'and jitter. Consumers opt out by shrinking `retryableErrors` to an empty array.',
    metadata: { file: 'docs/architecture/02-agent-loop.md', line: 42 },
  },
  {
    id: 'docs/architecture/10-redact.md#L8',
    content:
      'The redact subpath ships four primitives that run before anything hits the logger. '
      + 'They never mutate the original message object — a cloned value carries the redactions.',
    metadata: { file: 'docs/architecture/10-redact.md', line: 8 },
  },
];

// ── 2. Deterministic embedding ──────────────────────────────────────────────
// A toy bag-of-words embedding so the example has no API-key dependency.
// The dimensions are fixed so index + retrieve share the same space.
const VOCAB = Array.from(
  new Set(
    CORPUS.flatMap((d) => d.content.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 4)),
  ),
).sort();

function embedText(text: string): number[] {
  const vec = new Array(VOCAB.length).fill(0) as number[];
  for (const tok of text.toLowerCase().split(/[^a-z]+/)) {
    const idx = VOCAB.indexOf(tok);
    if (idx >= 0) {
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
  }
  return vec;
}

const embeddingModel: EmbeddingModel = {
  dimensions: VOCAB.length,
  async embed(texts: readonly string[], _options?: EmbedOptions): Promise<number[][]> {
    return texts.map((t) => embedText(t));
  },
};

// ── 3. Guardrail pipeline (fail-closed) ─────────────────────────────────────
// Every retrieved chunk is scanned for prompt-injection before the reader
// sees it. A block verdict causes that chunk to be dropped, not redacted —
// RAG-injection must never slide through as "sanitised".
const pipeline = createPipeline({
  input: [createInjectionDetector({ sensitivity: 'medium' })],
});

async function filterSafeChunks(
  chunks: readonly DocumentChunk[],
): Promise<DocumentChunk[]> {
  const safe: DocumentChunk[] = [];
  for (const c of chunks) {
    const verdict = await runInput(pipeline, { content: c.content });
    if (verdict.passed) {
      safe.push(c);
    } else {
      const reason = 'reason' in verdict.verdict ? verdict.verdict.reason : 'policy violation';
      console.log(`[guardrail] dropped chunk ${c.id}: ${reason}`);
    }
  }
  return safe;
}

// ── 4. Reader (mock AgentLoop) ──────────────────────────────────────────────
// In production this is a real Anthropic/OpenAI adapter. Here we use the
// testing mock so the example runs in CI without API keys. The mock returns
// a deterministic answer derived from the citations so the wiring is
// observable without an LLM.

function deterministicAnswer(citations: readonly Citation[]): string {
  const best = citations[0]!;
  return [
    `Based on [1]:`,
    `> ${best.snippet}`,
    '',
    `(See ${best.file}:${best.line} for the full context.)`,
  ].join('\n');
}

async function ask(
  question: string,
  retriever: ReturnType<typeof createInMemoryRetriever>,
): Promise<AskResult> {
  const raw = await retriever.retrieve(question, { limit: 3 });
  const safe = await filterSafeChunks(raw.map((r) => r.chunk));

  const citations: Citation[] = safe.map((chunk, i) => ({
    file: (chunk.metadata?.['file'] as string | undefined) ?? chunk.id,
    line: (chunk.metadata?.['line'] as number | undefined) ?? 0,
    snippet: chunk.content.trim(),
    score: raw[i]?.score ?? 0,
  }));

  if (citations.length === 0) {
    return {
      question,
      answer: `I could not find anything about "${question}" in the corpus.`,
      citations: [],
    };
  }

  const contextBlock = citations
    .map((c, i) => `[${i + 1}] ${c.file}:${c.line}\n${c.snippet}`)
    .join('\n\n');

  const systemPrompt = [
    'You are answering questions about the harness-one codebase.',
    'Use ONLY the provided context. Cite sources by their bracketed number.',
    '',
    'Context:',
    contextBlock,
  ].join('\n');

  const adapter = createMockAdapter({
    responses: [{ content: deterministicAnswer(citations) }],
    usage: { inputTokens: 200, outputTokens: 80 },
  });

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question },
  ];

  const loop = new AgentLoop({
    adapter,
    maxIterations: 1,
    maxTotalTokens: 10_000,
  });

  let answer = '';
  for await (const event of loop.run(messages)) {
    if (event.type === 'message' && event.message.role === 'assistant') {
      answer = event.message.content;
    }
  }

  return { question, answer, citations };
}

function renderResult(result: AskResult): string {
  if (result.citations.length === 0) {
    return result.answer;
  }
  const citationList = result.citations
    .map((c, i) => `  [${i + 1}] \`${c.file}:${c.line}\` (score=${c.score.toFixed(3)})`)
    .join('\n');
  return [
    `Question: ${result.question}`,
    '',
    'Answer:',
    result.answer,
    '',
    'Citations:',
    citationList,
  ].join('\n');
}

// ── 5. Pipeline orchestration ──────────────────────────────────────────────
async function main(): Promise<void> {
  const loader = createDocumentArrayLoader([...CORPUS]);
  const chunker = createBasicParagraphChunking({ maxChunkSize: 400 });
  const retriever = createInMemoryRetriever({ embedding: embeddingModel });

  // Load → chunk → embed → index.
  const documents = await loader.load();
  const rawChunks = documents.flatMap((d) => chunker.chunk(d));
  const vectors = await embeddingModel.embed(rawChunks.map((c) => c.content));
  const embeddedChunks: DocumentChunk[] = rawChunks.map((c, i) => ({
    ...c,
    embedding: vectors[i] ?? [],
  }));
  await retriever.index(embeddedChunks);

  const questions = [
    'What happens when a guardrail blocks input?',
    'How does the adapter signal that a stream is truncated?',
  ];

  for (const q of questions) {
    console.log('\n=== Question ===');
    console.log(q);
    const result = await ask(q, retriever);
    console.log(renderResult(result));
  }
}

main().catch((err: unknown) => {
  console.error('[example:codebase-qa] failed:', err);
  process.exit(1);
});
