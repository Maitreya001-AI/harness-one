/**
 * Example · Confidence-gated outer loop with harness-one fallback adapter.
 *
 * Demonstrates two harness-one primitives in a research-loop shape:
 *
 *   1. `createFallbackAdapter` from `harness-one/advanced` — when the
 *      primary "search provider" fails, the call automatically falls over
 *      to a backup. Concurrency-safe.
 *   2. `computeBackoffMs` from `harness-one/advanced` — deterministic
 *      exponential backoff with bounded jitter. Production-grade retry
 *      math without dependencies.
 *
 * The four-state outer loop (search → read → refine → evaluate) is
 * application code, NOT a harness-one feature. harness-one supplies the
 * resilience primitives; the application owns the state machine.
 *
 * Stopping rule: confidence ≥ 0.85 OR `maxIterations` reached. The
 * iteration cap is the back-stop, not the primary stop.
 *
 *   pnpm tsx examples/autoresearch-loop.ts
 *
 * No peer SDK, no API key — this example runs in CI under
 * `examples:smoke`.
 */
import { createFallbackAdapter, computeBackoffMs } from 'harness-one/advanced';
import { createMockAdapter, createFailingAdapter } from 'harness-one/testing';
import type { AgentAdapter, ChatParams } from 'harness-one/core';

// ── 1. Domain model ────────────────────────────────────────────────────────

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

// ── 2. The "search index" the fallback adapter returns ─────────────────────
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

// ── 3. Build the fallback-wrapped adapter ──────────────────────────────────
//
// In production, "primary" and "fallback" would be real LLM adapters
// (e.g., Anthropic primary, OpenAI fallback). Here we abuse the adapter
// abstraction to shape "search calls" — the failing-then-recovering shape
// is what we want to demonstrate, not the actual semantics.
//
// The PRIMARY adapter always fails (simulated 503) so every call exercises
// the fallback path. The FALLBACK adapter returns a JSON-encoded list of
// sources, which the application below parses into Source[].
//
// `createFallbackAdapter` switches to the next adapter after `maxFailures`
// consecutive failures. We set `maxFailures: 1` so the very first failure
// trips the breaker, which keeps the example snappy.

function buildSearchAdapter(): AgentAdapter {
  const primary = createFailingAdapter(
    new Error('primary search unreachable (simulated 503)'),
  );

  const fallback = createMockAdapter({
    responses: [{ content: JSON.stringify(INDEX) }],
    usage: { inputTokens: 100, outputTokens: 50 },
  });

  return createFallbackAdapter({
    adapters: [primary, fallback],
    maxFailures: 1,
  });
}

// ── 4. Search step (uses harness-one fallback adapter + backoff) ───────────
async function searchWithBackoff(
  adapter: AgentAdapter,
  topic: string,
): Promise<readonly Source[]> {
  const params: ChatParams = {
    messages: [{ role: 'user', content: `Find sources for: ${topic}` }],
  };

  // Outer retry: even after the fallback adapter trips, we still want to
  // retry the whole chain a few times in case the fallback itself is
  // momentarily unavailable. This is application-level retry around the
  // adapter chain — separate from the per-adapter circuit-breaker logic
  // inside `createFallbackAdapter`.
  const maxAttempts = 3;
  // Deterministic random source so backoff math is reproducible under
  // `examples:smoke`.
  const random = ((): (() => number) => {
    let i = 0;
    return () => {
      i += 1;
      return ((i * 0.37) % 1);
    };
  })();

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await adapter.chat(params);
      return JSON.parse(response.message.content) as Source[];
    } catch (err) {
      lastErr = err;
      const delayMs = computeBackoffMs(attempt, {
        baseMs: 25,
        maxMs: 200,
        jitterFraction: 0.1,
        random,
      });
      console.log(
        `  [search] attempt ${attempt + 1} failed: ${(err as Error).message}; backoff ${delayMs}ms`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('search exhausted');
}

// ── 5. Deterministic reader ────────────────────────────────────────────────
function readSource(state: LoopState, source: Source): { summary: string; delta: number } {
  const alreadyCited = state.cites.some((c) => c.id === source.id);
  if (alreadyCited) return { summary: '', delta: 0 };
  const summary = `${source.title} — ${source.url}`;
  return { summary, delta: source.quality };
}

// ── 6. Outer loop (application code, NOT from harness-one) ─────────────────
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

  // Build the search adapter once; it's reusable across iterations. The
  // fallback adapter handles primary failure internally — application
  // code does NOT need its own try/catch for that.
  const searchAdapter = buildSearchAdapter();

  for (let i = 0; i < maxIterations; i++) {
    const elapsed = Date.now() - start;
    console.log(
      `\n[${elapsed}ms] iteration ${i + 1}, confidence=${state.confidence.toFixed(2)}`,
    );

    // SEARCH state
    state.attempts.search += 1;
    const sources = await searchWithBackoff(searchAdapter, topic);

    const unseen = sources.filter((s) => !state.cites.some((c) => c.id === s.id));
    if (unseen.length === 0) {
      console.log('  [search] no new sources — bailing out');
      break;
    }
    unseen.sort((a, b) => b.quality - a.quality);
    const source = unseen[0]!;

    // READ state
    state.attempts.read += 1;
    const { summary, delta } = readSource(state, source);
    if (summary) {
      state.cites.push(source);
      state.answer = state.answer ? `${state.answer}\n- ${summary}` : `- ${summary}`;
      state.confidence = Math.min(1, state.confidence + delta);
      console.log(`  [read] +${delta.toFixed(2)} confidence from ${source.id}`);
    }

    // EVALUATE state
    if (state.confidence >= target) {
      console.log(
        `  [evaluate] confidence ${state.confidence.toFixed(2)} ≥ ${target} — stopping`,
      );
      break;
    }
    // REFINE state — implicit (next iteration loops back to SEARCH)
  }

  return state;
}

// ── 7. Entry ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const topic = 'How does harness-one handle transient provider errors?';
  console.log(`=== Autoresearch: ${topic} ===`);
  const result = await autoresearch(topic);
  console.log('\n=== Report ===');
  console.log(`Final confidence: ${result.confidence.toFixed(2)}`);
  console.log(`Search attempts: ${result.attempts.search}`);
  console.log(`Sources read: ${result.cites.length}`);
  console.log('\nAnswer:');
  console.log(result.answer || '(no content gathered)');
}

main().catch((err: unknown) => {
  console.error('[example:autoresearch-loop] failed:', err);
  process.exit(1);
});
