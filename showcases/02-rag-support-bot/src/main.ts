/**
 * Showcase 02 · Single-turn RAG Support Bot.
 *
 * Form-pressure target: rag (multi-tenant scope) + guardrails
 * (injection detector on retrieved chunks) + context (chunks → system
 * prompt) + AgentLoop reader. See PLAN.md for the 15-pressure-point list
 * and HYPOTHESIS.md for predictions.
 *
 *   pnpm start
 *
 * Deterministic / no API key — uses a bag-of-words embedding for the
 * retriever and a mock AgentLoop adapter for the reader.
 */
import {
  createBasicParagraphChunking,
  createDocumentArrayLoader,
  createInMemoryRetriever,
} from 'harness-one/rag';
import type { DocumentChunk, EmbeddingModel } from 'harness-one/rag';
import {
  createInjectionDetector,
  createPipeline,
  runInput,
} from 'harness-one/guardrails';
import { AgentLoop } from 'harness-one/core';
import type { Message } from 'harness-one/core';
import { createMockAdapter } from 'harness-one/testing';
import { ALPHA_DOCS, BETA_DOCS, SCENARIOS } from './fixtures.js';
import type { ScenarioCase, TenantDoc, TenantId } from './fixtures.js';

// ── 1. Deterministic embedding ─────────────────────────────────────────────
function buildVocab(docs: readonly TenantDoc[]): readonly string[] {
  const set = new Set<string>();
  for (const d of docs) {
    for (const tok of d.content.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length >= 3) set.add(tok);
    }
  }
  return Array.from(set).sort();
}

function buildEmbedder(vocab: readonly string[]): EmbeddingModel {
  return {
    dimensions: vocab.length,
    async embed(texts: readonly string[]): Promise<number[][]> {
      return texts.map((t) => {
        const vec = new Array<number>(vocab.length).fill(0);
        for (const tok of t.toLowerCase().split(/[^a-z0-9]+/)) {
          const idx = vocab.indexOf(tok);
          if (idx >= 0) vec[idx] = (vec[idx] ?? 0) + 1;
        }
        return vec;
      });
    },
  };
}

// ── 2. Guardrail pipeline (fail-closed on retrieved chunks) ────────────────
const pipeline = createPipeline({
  input: [createInjectionDetector({ sensitivity: 'medium' })],
});

interface FilteredChunk {
  readonly chunk: DocumentChunk;
  readonly score: number;
}

interface FilterResult {
  readonly safe: FilteredChunk[];
  readonly droppedAdversarial: number;
  readonly droppedTotal: number;
}

async function filterChunks(
  chunks: { chunk: DocumentChunk; score: number }[],
): Promise<FilterResult> {
  const safe: FilteredChunk[] = [];
  let droppedAdversarial = 0;
  let droppedTotal = 0;
  for (const c of chunks) {
    const verdict = await runInput(pipeline, { content: c.chunk.content });
    if (verdict.passed) {
      safe.push(c);
    } else {
      droppedTotal += 1;
      if (c.chunk.metadata?.['adversarial'] === true) droppedAdversarial += 1;
      const reason = 'reason' in verdict.verdict
        ? verdict.verdict.reason
        : 'policy violation';
      console.log(`  [guardrail] dropped ${c.chunk.id} — ${reason}`);
    }
  }
  return { safe, droppedAdversarial, droppedTotal };
}

// ── 3. Reader (mock AgentLoop) ─────────────────────────────────────────────
function deterministicAnswer(safe: readonly FilteredChunk[]): string {
  if (safe.length === 0) {
    return 'I could not find anything in this tenant\'s corpus to support an answer.';
  }
  const top = safe[0]!;
  const meta = top.chunk.metadata as { file?: string; line?: number } | undefined;
  return [
    `Based on [1]:`,
    `> ${top.chunk.content.trim()}`,
    '',
    `(See ${meta?.file ?? top.chunk.id}:${meta?.line ?? 0}.)`,
  ].join('\n');
}

interface AskResult {
  readonly question: string;
  readonly tenant: TenantId;
  readonly answer: string;
  readonly safeCount: number;
  readonly droppedAdversarial: number;
  readonly citations: readonly { file: string; line: number; score: number }[];
}

async function ask(
  scenario: ScenarioCase,
  retriever: ReturnType<typeof createInMemoryRetriever>,
): Promise<AskResult> {
  const raw = await retriever.retrieve(scenario.question, {
    limit: 4,
    tenantId: scenario.tenant,
  });

  const filtered = await filterChunks(
    raw.map((r) => ({ chunk: r.chunk, score: r.score })),
  );

  const citations = filtered.safe.map((s) => {
    const m = s.chunk.metadata as { file?: string; line?: number } | undefined;
    return {
      file: m?.file ?? s.chunk.id,
      line: m?.line ?? 0,
      score: s.score,
    };
  });

  if (filtered.safe.length === 0) {
    return {
      question: scenario.question,
      tenant: scenario.tenant,
      answer: deterministicAnswer([]),
      safeCount: 0,
      droppedAdversarial: filtered.droppedAdversarial,
      citations,
    };
  }

  const contextBlock = filtered.safe
    .map((s, i) => {
      const m = s.chunk.metadata as { file?: string; line?: number } | undefined;
      return `[${i + 1}] ${m?.file ?? s.chunk.id}:${m?.line ?? 0}\n${s.chunk.content}`;
    })
    .join('\n\n');

  const systemPrompt = [
    `You answer support questions for tenant "${scenario.tenant}" using ONLY the provided context.`,
    'Cite sources by their bracketed number. If the context is empty, say so.',
    '',
    'Context:',
    contextBlock,
  ].join('\n');

  const adapter = createMockAdapter({
    responses: [{ content: deterministicAnswer(filtered.safe) }],
    usage: { inputTokens: 200 + scenario.question.length, outputTokens: 90 },
  });

  const loop = new AgentLoop({
    adapter,
    maxIterations: 1,
    maxTotalTokens: 8_000,
  });

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: scenario.question },
  ];

  let answer = '';
  for await (const event of loop.run(messages)) {
    if (event.type === 'message' && event.message.role === 'assistant') {
      answer = event.message.content;
    }
  }

  return {
    question: scenario.question,
    tenant: scenario.tenant,
    answer,
    safeCount: filtered.safe.length,
    droppedAdversarial: filtered.droppedAdversarial,
    citations,
  };
}

// ── 4. Per-scenario assertions ─────────────────────────────────────────────
interface ScenarioOutcome {
  readonly scenario: ScenarioCase;
  readonly result: AskResult;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

function assertScenario(scenario: ScenarioCase, result: AskResult): ScenarioOutcome {
  const failures: string[] = [];

  for (const expectedFile of scenario.expectedFiles) {
    if (!result.citations.some((c) => c.file === expectedFile)) {
      failures.push(
        `expected citation for ${expectedFile}; got [${result.citations.map((c) => c.file).join(', ')}]`,
      );
    }
  }

  if (result.droppedAdversarial < scenario.expectAdversarialDropped) {
    failures.push(
      `expected ≥${scenario.expectAdversarialDropped} adversarial drops; got ${result.droppedAdversarial}`,
    );
  }

  for (const c of result.citations) {
    if (!c.file.startsWith(scenario.tenant + '/')) {
      failures.push(`tenant leak: citation ${c.file} not in tenant '${scenario.tenant}'`);
    }
  }

  return { scenario, result, passed: failures.length === 0, failures };
}

// ── 5. Pipeline orchestration ──────────────────────────────────────────────
async function main(): Promise<void> {
  const allDocs = [...ALPHA_DOCS, ...BETA_DOCS];
  const vocab = buildVocab(allDocs);
  const embedding = buildEmbedder(vocab);

  const loader = createDocumentArrayLoader(allDocs);
  const chunker = createBasicParagraphChunking({ maxChunkSize: 400 });
  const retriever = createInMemoryRetriever({ embedding });

  const documents = await loader.load();
  const allChunks = documents.flatMap((d) => chunker.chunk(d));

  // Embed first, then index per tenant. Tenant tag lives on the source
  // document's metadata; chunking propagates it.
  const vectors = await embedding.embed(allChunks.map((c) => c.content));
  const embedded: DocumentChunk[] = allChunks.map((c, i) => ({
    ...c,
    embedding: vectors[i] ?? [],
  }));

  // Group by tenant so each goes through indexScoped(); the in-memory
  // retriever keeps the partitions disjoint at retrieve() time.
  const byTenant: Record<TenantId, DocumentChunk[]> = { alpha: [], beta: [] };
  for (const ch of embedded) {
    const t = ch.metadata?.['tenant'] as TenantId | undefined;
    if (!t) throw new Error(`chunk ${ch.id} missing tenant`);
    byTenant[t].push(ch);
  }
  await retriever.indexScoped(byTenant.alpha, 'alpha');
  await retriever.indexScoped(byTenant.beta, 'beta');

  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of SCENARIOS) {
    console.log(`\n=== [${scenario.tenant}] ${scenario.question} ===`);
    const result = await ask(scenario, retriever);
    const outcome = assertScenario(scenario, result);
    console.log(result.answer);
    console.log(`  citations: ${result.citations.length} (${result.citations.map((c) => `${c.file}@${c.score.toFixed(3)}`).join(', ')})`);
    console.log(`  adversarial dropped: ${result.droppedAdversarial}`);
    console.log(`  status: ${outcome.passed ? 'PASS' : 'FAIL'}`);
    if (!outcome.passed) {
      for (const f of outcome.failures) console.log(`    - ${f}`);
    }
    outcomes.push(outcome);
  }

  const passed = outcomes.filter((o) => o.passed).length;
  console.log(`\n=== Summary ===`);
  console.log(`${passed}/${outcomes.length} scenarios passed`);
  if (passed !== outcomes.length) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('[showcase-02] fatal:', err);
  process.exit(1);
});
