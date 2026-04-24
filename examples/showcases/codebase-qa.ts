/**
 * Showcase · Codebase Q&A with RAG + fail-closed guardrails.
 *
 * Why this example is different from `examples/rag/custom-pipeline.ts`:
 *   - It closes the loop end-to-end. The retriever is wired to a
 *     deterministic reader so there's no live LLM key required.
 *   - It demonstrates `harness-one/guardrails` running *on each retrieved
 *     chunk* before the reader sees it — the RAG-injection mitigation the
 *     README promises.
 *   - It emits file:line-style citations in the final answer, so you can
 *     see what a production citation pipeline would look like.
 *
 *   pnpm tsx examples/showcases/codebase-qa.ts
 *
 * No peer SDK, no API key — this showcase runs in CI under `examples:smoke`.
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

interface Citation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly score: number;
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
// A toy bag-of-words embedding so the showcase has no API-key dependency.
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

// ── 4. Deterministic reader ────────────────────────────────────────────────
function render(question: string, citations: readonly Citation[]): string {
  if (citations.length === 0) {
    return `I could not find anything about "${question}" in the corpus.`;
  }
  const best = citations[0]!;
  const linked = citations
    .map((c) => `- \`${c.file}:${c.line}\` — "${c.snippet.slice(0, 80)}${c.snippet.length > 80 ? '…' : ''}"`)
    .join('\n');
  return [
    `Question: ${question}`,
    '',
    `Short answer (quoting \`${best.file}:${best.line}\`):`,
    `> ${best.snippet}`,
    '',
    'Sources:',
    linked,
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
    const raw = await retriever.retrieve(q, { limit: 3 });
    const safe = await filterSafeChunks(raw.map((r) => r.chunk));
    const citations: Citation[] = safe.map((chunk, i) => ({
      file: (chunk.metadata?.['file'] as string | undefined) ?? chunk.id,
      line: (chunk.metadata?.['line'] as number | undefined) ?? 0,
      snippet: chunk.content.trim(),
      score: raw[i]?.score ?? 0,
    }));
    console.log(render(q, citations));
  }
}

main().catch((err: unknown) => {
  console.error('[showcase:codebase-qa] failed:', err);
  process.exit(1);
});
