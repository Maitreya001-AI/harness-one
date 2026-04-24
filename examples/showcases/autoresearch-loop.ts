/**
 * Showcase · Autoresearch loop (Ralph style).
 *
 * A minimal research agent with four explicit states:
 *   1. search     — find candidate sources for the topic.
 *   2. read       — summarise the top result, producing a confidence score.
 *   3. refine     — fold new findings into the running answer.
 *   4. evaluate   — stop when confidence ≥ threshold, else loop.
 *
 * The showcase focuses on three things the rest of the examples don't:
 *   - Stop criterion gated by a confidence float, not just an iteration
 *     count. Iteration cap is the back-stop, not the primary stop.
 *   - A fallback path: the first "search call" fails on purpose, so the
 *     loop exercises exponential backoff + fallback source. That is the
 *     resilience narrative turned into a runnable test vector.
 *   - A running trace: every state transition is printed with elapsed
 *     wall-clock so readers can see how the loop times itself.
 *
 * No peer SDK, no API key — this showcase runs in CI under `examples:smoke`.
 */

interface Source {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  /** Deterministic "quality" this source contributes to the answer. */
  readonly quality: number;
}

interface LoopState {
  readonly topic: string;
  answer: string;
  confidence: number;
  readonly cites: Source[];
  readonly attempts: { search: number; read: number };
}

// ── 1. Fake search index ───────────────────────────────────────────────────
// In production this is a retriever over real docs. Here we ship a fixed
// list so every run produces the same narrative.
const INDEX: readonly Source[] = [
  {
    id: 'a',
    url: 'https://example.test/harness-fundamentals',
    title: 'Harness engineering fundamentals',
    quality: 0.4,
  },
  {
    id: 'b',
    url: 'https://example.test/agent-loop-internals',
    title: 'Inside the AgentLoop — retry, tools, guardrails',
    quality: 0.35,
  },
  {
    id: 'c',
    url: 'https://example.test/resilience-patterns',
    title: 'Resilience patterns in agent infrastructure',
    quality: 0.3,
  },
];

// ── 2. A deliberately flaky "primary" search ───────────────────────────────
let primaryAttempts = 0;
async function primarySearch(topic: string): Promise<readonly Source[]> {
  primaryAttempts += 1;
  if (primaryAttempts === 1) {
    throw new Error('primary search unreachable (simulated 503)');
  }
  return INDEX.filter((s) => s.title.toLowerCase().includes(topicKeyword(topic)));
}

// ── 3. A fallback that is always available ─────────────────────────────────
async function fallbackSearch(_topic: string): Promise<readonly Source[]> {
  return INDEX;
}

function topicKeyword(topic: string): string {
  const tokens = topic.toLowerCase().split(/\W+/).filter((t) => t.length >= 4);
  return tokens[0] ?? '';
}

// ── 4. Exponential backoff with jitter (no external dep) ───────────────────
async function sleepWithBackoff(attempt: number): Promise<void> {
  const base = 25; // keep the showcase snappy; production would use 500ms+
  const cap = 200;
  const delay = Math.min(cap, base * 2 ** attempt);
  // Deterministic jitter — use attempt as the seed so the showcase is
  // reproducible under `examples:smoke`.
  const jitter = (attempt * 7) % 5;
  await new Promise((r) => setTimeout(r, delay + jitter));
}

// ── 5. Search with fallback ────────────────────────────────────────────────
async function searchWithFallback(topic: string): Promise<readonly Source[]> {
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await primarySearch(topic);
      if (result.length > 0) return result;
    } catch (err) {
      console.log(`  [search] primary failed (${(err as Error).message}) — backing off ${attempt}`);
      await sleepWithBackoff(attempt);
    }
  }
  console.log('  [search] primary exhausted — falling back to static index');
  return fallbackSearch(topic);
}

// ── 6. Deterministic reader ────────────────────────────────────────────────
// Produces a summary and a confidence delta. The "delta" mimics a real
// reader that is more confident the more relevant sources it has seen.
function readSource(state: LoopState, source: Source): { summary: string; delta: number } {
  const alreadyCited = state.cites.some((c) => c.id === source.id);
  if (alreadyCited) return { summary: '', delta: 0 };
  const summary = `${source.title} — ${source.url}`;
  return { summary, delta: source.quality };
}

// ── 7. Main loop ───────────────────────────────────────────────────────────
async function autoresearch(topic: string): Promise<LoopState> {
  const state: LoopState = {
    topic,
    answer: '',
    confidence: 0,
    cites: [],
    attempts: { search: 0, read: 0 },
  };
  const target = 0.85;
  const maxIterations = 6;
  const start = Date.now();

  for (let i = 0; i < maxIterations; i++) {
    const elapsed = Date.now() - start;
    console.log(`\n[${elapsed}ms] iteration ${i + 1}, confidence=${state.confidence.toFixed(2)}`);

    // Search step
    state.attempts.search += 1;
    const sources = await searchWithFallback(topic);

    // Pick the most promising unseen source
    const unseen = sources.filter((s) => !state.cites.some((c) => c.id === s.id));
    if (unseen.length === 0) {
      console.log('  [search] no new sources — bailing out');
      break;
    }
    unseen.sort((a, b) => b.quality - a.quality);
    const source = unseen[0]!;

    // Read step
    state.attempts.read += 1;
    const { summary, delta } = readSource(state, source);
    if (summary) {
      state.cites.push(source);
      state.answer = state.answer ? `${state.answer}\n- ${summary}` : `- ${summary}`;
      state.confidence = Math.min(1, state.confidence + delta);
      console.log(`  [read] +${delta.toFixed(2)} confidence from ${source.id}`);
    }

    if (state.confidence >= target) {
      console.log(`  [evaluate] confidence ${state.confidence.toFixed(2)} ≥ ${target} — stopping`);
      break;
    }
  }

  return state;
}

// ── 8. Entry ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const topic = 'How does harness-one handle transient provider errors?';
  console.log(`=== Autoresearch: ${topic} ===`);
  const result = await autoresearch(topic);
  console.log('\n=== Report ===');
  console.log(`Final confidence: ${result.confidence.toFixed(2)}`);
  console.log(`Search attempts: ${result.attempts.search} (primary attempts: ${primaryAttempts})`);
  console.log(`Sources read: ${result.cites.length}`);
  console.log('\nAnswer:');
  console.log(result.answer || '(no content gathered)');
}

main().catch((err: unknown) => {
  console.error('[showcase:autoresearch] failed:', err);
  process.exit(1);
});
