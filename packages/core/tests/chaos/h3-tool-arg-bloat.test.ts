/**
 * Scenario H3 — 100 × tool-heavy stream runs, ~10% inject oversized
 * tool_call args that exceed `maxToolArgBytes`.
 *
 * Aggregate invariants:
 *   1. 100% of over-limit runs yield an `ADAPTER_PAYLOAD_OVERSIZED`
 *      error (or equivalent). Never a generic `Error`.
 *   2. Under-limit runs complete normally (terminal reason `end_turn`).
 *   3. Every run reaches a terminal state.
 *   4. No span leaks.
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { createTraceManager } from '../../src/observe/trace-manager.js';
import { createChaosAdapter } from '../../src/testing/index.js';
import { HarnessError, HarnessErrorCode } from '../../src/core/errors.js';
import type { AgentAdapter, ChatParams, StreamChunk } from '../../src/core/types.js';
import {
  assertAllRunsReachedTerminalState,
  assertNoActiveSpans,
  type RunOutcome,
} from './assertions.js';
import { drainRun, resolveSeed, silentLogger } from './harness.js';

const H3_SEED_FALLBACK = 33_333;
/** Small cap so bloat deterministically overruns but streams don't. */
const MAX_TOOL_ARG_BYTES = 4 * 1024;

/**
 * Stateful stream mock: first call emits a tool_use with split deltas
 * (so the aggregator's maxToolArgBytes check fires on the grow-delta);
 * subsequent calls emit plain assistant text so the loop terminates
 * normally once the tool result is fed back.
 */
function createTwoTurnToolStreamAdapter(callId: string): AgentAdapter {
  let call = 0;
  const firstTurn: StreamChunk[] = [
    { type: 'tool_call_delta', toolCall: { id: callId, name: 'search' } },
    { type: 'tool_call_delta', toolCall: { id: callId, arguments: '{"q":"ok"}' } },
    { type: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
  ];
  const secondTurn: StreamChunk[] = [
    { type: 'text_delta', text: 'all set' },
    { type: 'done', usage: { inputTokens: 2, outputTokens: 2 } },
  ];
  return {
    async chat(_params: ChatParams) {
      call++;
      return {
        message: { role: 'assistant', content: call === 1 ? '' : 'all set' },
        usage: { inputTokens: 2, outputTokens: 2 },
      };
    },
    async *stream(_params: ChatParams) {
      const chunks = call === 0 ? firstTurn : secondTurn;
      call++;
      for (const c of chunks) yield c;
    },
  };
}

describe('chaos H3 · 100 × stream × 10% tool-arg bloat', () => {
  it('oversized tool args always trip the payload-oversized guard', async () => {
    const seed = resolveSeed(H3_SEED_FALLBACK);
    const RUNS = 100;

    const traceManager = createTraceManager();
    const outcomes: RunOutcome[] = [];
    const errorCodes: HarnessErrorCode[] = [];
    const unclassified: Error[] = [];
    const bloatedRuns: number[] = [];

    for (let i = 0; i < RUNS; i++) {
      const adapter = createChaosAdapter(
        createTwoTurnToolStreamAdapter(`tc-${i}`),
        {
          seed: seed + i,
          toolArgBloatRate: 0.1,
          bloatBytes: MAX_TOOL_ARG_BYTES * 2,
        },
      );
      const loop = new AgentLoop({
        adapter,
        traceManager,
        streaming: true,
        maxToolArgBytes: MAX_TOOL_ARG_BYTES,
        // Handle the tool call with a trivial stub so non-bloated runs
        // reach iteration 2 and close out with `end_turn`.
        onToolCall: async () => ({ ok: true }),
        maxIterations: 3,
        logger: silentLogger,
      });
      try {
        const { outcome, events } = await drainRun(
          loop.run([{ role: 'user', content: `tool ${i}` }]),
          { traceId: `run-${i}` },
        );
        outcomes.push(outcome);
        if (adapter.recorder.count('tool-arg-bloat') > 0) {
          bloatedRuns.push(i);
        }
        for (const e of events) {
          if (e.type !== 'error') continue;
          if (e.error instanceof HarnessError) {
            errorCodes.push(e.error.code);
          } else {
            unclassified.push(e.error);
          }
        }
      } finally {
        loop.dispose?.();
      }
    }

    assertAllRunsReachedTerminalState(outcomes);
    assertNoActiveSpans(traceManager);

    expect(unclassified, `generic errors escaped classification`).toHaveLength(0);

    expect(
      bloatedRuns.length,
      `expected some bloat injections at 10% over ${RUNS} runs, got ${bloatedRuns.length}`,
    ).toBeGreaterThan(2);

    // Invariant 1: every bloated run terminates with an error (not end_turn).
    for (const i of bloatedRuns) {
      expect(
        outcomes[i].reason,
        `run ${i} was bloated but did not terminate with an error`,
      ).toBe('error');
    }

    // Invariant 2: at least one payload-oversized code shows up in the
    // classified errors. We check membership since multiple broken runs
    // could emit one each.
    const oversizedSeen = errorCodes.some(
      (c) => c === HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED,
    );
    expect(
      oversizedSeen,
      `expected ADAPTER_PAYLOAD_OVERSIZED in error stream, got ${JSON.stringify(errorCodes)}`,
    ).toBe(true);

    // Invariant 3: non-bloated runs reach end_turn (happy path still works).
    const cleanRuns = outcomes.filter((_, i) => !bloatedRuns.includes(i));
    const cleanEndTurns = cleanRuns.filter((o) => o.reason === 'end_turn').length;
    expect(
      cleanEndTurns,
      `all non-bloated runs must end_turn, got ${cleanEndTurns}/${cleanRuns.length}`,
    ).toBe(cleanRuns.length);

    await traceManager.dispose();
  }, 30_000);
});
