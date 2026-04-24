/**
 * Scenario H5 — 100 × tool-calling run, 15% probability the adapter
 * returns non-parsable JSON in the first tool call's arguments.
 *
 * Aggregate invariants:
 *   1. 100% of invalid-JSON cases surface as a `tool_result` carrying
 *      `{ error, errorName }` — never an unhandled parse exception.
 *   2. `memoryStore` has no half-written entries — `reconcileIndex()` is
 *      idempotent across two consecutive calls.
 *   3. Every run reaches a terminal state.
 *   4. No span leaks.
 *
 * The handler parses `arguments` as JSON, then writes the payload to
 * an `FsMemoryStore`. A JSON.parse failure throws BEFORE the write, so
 * invalid runs never land partial state on disk — that's the invariant
 * the scenario proves.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { createTraceManager } from '../../src/observe/trace-manager.js';
import { createFileSystemStore } from '../../src/memory/fs-store.js';
import { createChaosAdapter } from '../../src/testing/index.js';
import type { AgentAdapter, ChatParams } from '../../src/core/types.js';
import {
  assertAllRunsReachedTerminalState,
  assertMemoryStoreConsistent,
  assertNoActiveSpans,
  type RunOutcome,
} from './assertions.js';
import { drainRun, resolveSeed, silentLogger } from './harness.js';

const H5_SEED_FALLBACK = 55_555;

/**
 * Stateful mock: first chat() call returns a tool use; subsequent calls
 * return a terminal text message so the loop finishes after receiving
 * the tool result.
 */
function createTwoTurnToolChatAdapter(callId: string): AgentAdapter {
  let call = 0;
  return {
    async chat(_params: ChatParams) {
      call++;
      if (call === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: callId, name: 'record', arguments: '{"key":"k","content":"c"}' },
            ],
          },
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      }
      return {
        message: { role: 'assistant', content: 'done' },
        usage: { inputTokens: 2, outputTokens: 2 },
      };
    },
  };
}

describe('chaos H5 · 100 × tool × 15% invalid JSON', () => {
  it('invalid JSON arguments route through tool_result error envelope, memory stays consistent', async () => {
    const seed = resolveSeed(H5_SEED_FALLBACK);
    const RUNS = 100;

    const tmpRoot = await mkdtemp(join(tmpdir(), 'chaos-h5-'));
    const store = createFileSystemStore({ directory: tmpRoot });
    const traceManager = createTraceManager();
    const outcomes: RunOutcome[] = [];
    const invalidRuns: number[] = [];
    const toolResultErrors: number[] = [];
    let unhandledParseErrors = 0;

    try {
      for (let i = 0; i < RUNS; i++) {
        const inner = createTwoTurnToolChatAdapter(`tc-${i}`);
        const adapter = createChaosAdapter(inner, {
          seed: seed + i,
          invalidJsonRate: 0.15,
        });

        const loop = new AgentLoop({
          adapter,
          traceManager,
          maxIterations: 3,
          logger: silentLogger,
          onToolCall: async (call) => {
            // Tool handler: parse the args. If parse throws, the strategy
            // wraps the thrown Error into `{ error, errorName }` and the
            // loop emits a tool_result event with that envelope — no
            // unhandled parse exception escapes the loop.
            const parsed = JSON.parse(call.arguments) as { key: string; content: string };
            await store.write({
              key: `${parsed.key}-${i}`,
              content: parsed.content,
              grade: 'ephemeral',
            });
            return { ok: true };
          },
        });

        try {
          const { outcome, events } = await drainRun(
            loop.run([{ role: 'user', content: `run ${i}` }]),
            { traceId: `run-${i}` },
          );
          outcomes.push(outcome);
          if (adapter.recorder.count('invalid-json') > 0) {
            invalidRuns.push(i);
            // Look for a tool_result event whose result is an error envelope.
            for (const e of events) {
              if (e.type === 'tool_result') {
                if (
                  typeof e.result === 'object' &&
                  e.result !== null &&
                  'error' in e.result
                ) {
                  toolResultErrors.push(i);
                }
              }
            }
          }
        } catch {
          // An unhandled error reaching here means the loop failed to
          // funnel the parse exception into the tool_result path.
          unhandledParseErrors++;
        } finally {
          loop.dispose?.();
        }
      }

      assertAllRunsReachedTerminalState(outcomes);
      assertNoActiveSpans(traceManager);

      // Invariant 1: no parse error escaped as an unhandled exception.
      expect(unhandledParseErrors, 'parse exceptions must not escape the loop').toBe(0);

      // Invariant 2: the scenario actually injected some invalid JSON.
      expect(
        invalidRuns.length,
        `expected some invalid-json injections at 15% over ${RUNS} runs, got ${invalidRuns.length}`,
      ).toBeGreaterThan(5);

      // Invariant 3: every invalid-json run saw a tool_result error envelope.
      // The set-comparison handles runs with duplicate tool_result events
      // from retries — we just need AT LEAST ONE per invalid run.
      const invalidRunsSet = new Set(invalidRuns);
      const seenErrors = new Set(toolResultErrors);
      for (const i of invalidRunsSet) {
        expect(
          seenErrors.has(i),
          `invalid-json run ${i} did not surface a tool_result error envelope`,
        ).toBe(true);
      }

      // Invariant 4: memory store is consistent — two reconciles match.
      await assertMemoryStoreConsistent(store);

      // Invariant 5: exactly one entry per CLEAN run landed. An invalid
      // JSON run must NOT leave a partial entry behind.
      const expected = RUNS - invalidRunsSet.size;
      const entries = await store.query({});
      expect(
        entries.length,
        `expected ${expected} memory entries (one per clean run), got ${entries.length}`,
      ).toBe(expected);
    } finally {
      await traceManager.dispose();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
