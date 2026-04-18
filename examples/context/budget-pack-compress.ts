/**
 * Example: Context engineering — `createBudget` + `packContext` + `compress`.
 *
 * The three primitives are independent and can be composed freely:
 *
 *   1. `createBudget`  — segmented token accounting + trim priority
 *   2. `packContext`   — HEAD/MID/TAIL layout; trims MID to fit budget
 *   3. `compress`      — strategy-based history compression (truncate /
 *                        sliding-window / summarize / preserve-failures)
 *
 * Pair with `countTokens` / `registerTokenizer` for exact BPE counts, and
 * `createCheckpointManager` for crash-safe conversation recovery
 * (see `resilience/checkpoint-manager.ts`).
 */
import {
  createBudget,
  packContext,
  compress,
  compactIfNeeded,
  countTokens,
} from 'harness-one/context';
import type { Message } from 'harness-one/core';

async function main(): Promise<void> {
  // ── 1. Budget — reserve space per segment ────────────────────────────────
  const budget = createBudget({
    totalTokens: 4000,
    responseReserve: 800, // leave headroom for model output
    segments: [
      { name: 'system',  maxTokens: 400,  reserved: true },
      { name: 'history', maxTokens: 2500, trimPriority: 1 }, // trim first
      { name: 'recent',  maxTokens: 300,  trimPriority: 0 },
    ],
  });
  budget.allocate('system', 200);
  budget.allocate('history', 1800);
  console.log('history remaining:', budget.remaining('history'));
  console.log('needsTrimming?', budget.needsTrimming());
  console.log('trimOrder:', budget.trimOrder());

  // ── 2. packContext — HEAD/MID/TAIL layout ───────────────────────────────
  // MID is trimmed from the front (oldest first) when HEAD+MID+TAIL exceeds
  // (totalTokens - responseReserve). HEAD and TAIL are never trimmed.
  const head: Message[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
  ];
  const mid: Message[] = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Historical turn ${i + 1} — some longish payload here to eat budget.`,
  }));
  const tail: Message[] = [
    { role: 'user', content: 'Latest user turn — always preserved.' },
  ];

  const packed = packContext({ head, mid, tail, budget }, 'default');
  console.log(`packed ${packed.messages.length} msgs, truncated=${packed.truncated}`);
  console.log('usage:', packed.usage);

  // ── 3. compress — reduce history with a chosen strategy ─────────────────
  const history: Message[] = [
    ...mid,
    { role: 'user', content: 'Summary of prior effort' },
    {
      role: 'assistant',
      content: 'Failure trace: tool X returned validation error',
      meta: { isFailureTrace: true }, // preserve-failures strategy keeps this
    },
  ];

  // 3a. truncate: keep tail messages until budget is hit.
  const truncated = await compress(history, { strategy: 'truncate', budget: 500 });
  console.log(`truncate: ${truncated.originalTokens} → ${truncated.finalTokens} tokens`);

  // 3b. sliding-window: keep the last N non-preserved messages.
  const window = await compress(history, {
    strategy: 'sliding-window',
    budget: 800,
    windowSize: 6,
  });
  console.log(`sliding-window: ${window.messages.length} messages kept`);

  // 3c. summarize: user-supplied summarizer replaces older turns with a digest.
  //     In production this summarizer would call an LLM; here we use a stub.
  const summarized = await compress(history, {
    strategy: 'summarize',
    budget: 600,
    summarizer: async (msgs) => `Summary of ${msgs.length} earlier turns.`,
    onError: (err, reason) =>
      console.warn(`[compress] fell back because: ${reason}`, err),
  });
  console.log(`summarize fallbackReason=${summarized.fallbackReason ?? 'none'}`);

  // 3d. preserve-failures: failure traces survive even past budget cuts.
  const preserved = await compress(history, {
    strategy: 'preserve-failures',
    budget: 300,
  });
  const keptFailures = preserved.messages.filter((m) => m.meta?.isFailureTrace).length;
  console.log(`preserve-failures: kept ${keptFailures} failure trace(s)`);

  // ── 4. compactIfNeeded — lazy compression on a threshold ─────────────────
  // Typical AgentLoop hook: before each iteration, run compactIfNeeded on the
  // current messages so compression only fires when budget pressure exists.
  const lazy = await compactIfNeeded(history, {
    budget: 1500,
    threshold: 0.75,
    strategy: 'truncate',
    countTokens: (ms) => countTokens('default', ms), // explicit, no global state
  });
  console.log(`compactIfNeeded returned ${lazy.length} messages`);
}

main().catch(console.error);
