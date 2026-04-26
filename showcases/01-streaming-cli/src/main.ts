/**
 * Showcase 01 · Streaming CLI Chat.
 *
 * Form-pressure target: `core` streaming + `session` (multi-turn) +
 * `observe` (lifecycle, cost). See PLAN.md for the full pressure-point
 * list and HYPOTHESIS.md for predictions.
 *
 * Two modes:
 *
 *   - `tsx src/main.ts` — interactive REPL. Reads stdin, calls AgentLoop
 *     in streaming mode, prints text_delta tokens as they arrive. Type
 *     `exit` or send Ctrl+D to leave; Ctrl+C cancels the in-flight turn.
 *   - `tsx src/main.ts --replay` — non-interactive mode used by CI. Runs
 *     a fixed sequence of turns with a deterministic streaming mock
 *     adapter, prints the same telemetry, exits 0 on success.
 *
 * Both modes exercise the same lifecycle / shutdown path so the showcase
 * proves the production graceful-shutdown contract.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { AgentLoop } from 'harness-one/core';
import type { AgentEvent, Message } from 'harness-one/core';
import {
  createTraceManager,
  createCostTracker,
  createHarnessLifecycle,
} from 'harness-one/observe';
import { createStreamingMockAdapter } from 'harness-one/testing';

import { pickReply, REPLAY_TURNS } from './scripted-replies.js';

const REPLAY_MODE = process.argv.includes('--replay');

// ── Telemetry plumbing ─────────────────────────────────────────────────────
const traces = createTraceManager();
const costs = createCostTracker({
  pricing: [
    {
      model: 'mock-stream',
      inputPer1kTokens: 0.001,
      outputPer1kTokens: 0.002,
    },
  ],
});
const lifecycle = createHarnessLifecycle();
lifecycle.markReady();

// Per-turn state captured for the end-of-session report.
interface TurnSummary {
  readonly turn: number;
  readonly question: string;
  readonly answer: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly wallClockMs: number;
  readonly doneReason: AgentEvent extends { type: 'done'; reason: infer R }
    ? R
    : string;
}

const turnLog: TurnSummary[] = [];

// Graceful-shutdown wiring. Tracks whether we're already draining so a
// second signal escalates to force-exit.
let draining = false;
let abortInFlight: AbortController | null = null;

function bindSignalHandlers(): void {
  const signalHandler = (signal: NodeJS.Signals): void => {
    if (signal === 'SIGINT' && abortInFlight && !abortInFlight.signal.aborted) {
      // First Ctrl+C during a turn cancels the turn but keeps the REPL.
      console.log('\n[shutdown] Ctrl+C — aborting current turn');
      abortInFlight.abort();
      return;
    }
    if (draining) {
      console.error(`[shutdown] ${signal} again — force exit`);
      process.exit(1);
    }
    draining = true;
    void shutdown(`signal:${signal}`).then(
      (code) => process.exit(code),
      (err: unknown) => {
        console.error('[shutdown] failed:', err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);
}

async function shutdown(reason: string): Promise<number> {
  // init → ready (already done at boot) → draining → shutdown.
  if (lifecycle.status() === 'ready') lifecycle.beginDrain();
  console.log(`\n[shutdown] reason=${reason}, draining...`);

  // Flush trace exporters (no-op exporter set has nothing to flush, but the
  // call itself is part of the contract we're proving).
  await traces.flush().catch((err: unknown) => {
    console.error('[shutdown] traces.flush error (non-fatal):', err);
  });

  printSessionReport();
  lifecycle.completeShutdown();
  lifecycle.dispose();
  return 0;
}

function printSessionReport(): void {
  console.log('\n=== Session report ===');
  console.log(`Turns:       ${turnLog.length}`);
  if (turnLog.length === 0) return;
  const totalIn = turnLog.reduce((s, t) => s + t.inputTokens, 0);
  const totalOut = turnLog.reduce((s, t) => s + t.outputTokens, 0);
  const totalCost = costs.getTotalCost();
  const wall = turnLog.reduce((s, t) => s + t.wallClockMs, 0);
  console.log(`Tokens:      input=${totalIn}, output=${totalOut}`);
  console.log(`Cost (USD):  ${totalCost.toFixed(6)}`);
  console.log(`Wall clock:  ${wall} ms total, ${(wall / turnLog.length).toFixed(0)} ms avg`);
  for (const t of turnLog) {
    console.log(
      `  turn ${t.turn}: ${t.wallClockMs}ms, in=${t.inputTokens} out=${t.outputTokens}, done=${String(t.doneReason)}`,
    );
  }
}

// ── Per-turn execution ─────────────────────────────────────────────────────
async function runTurn(
  turn: number,
  question: string,
  history: Message[],
): Promise<{ answer: string; inputTokens: number; outputTokens: number; doneReason: string }> {
  // Build a fresh streaming adapter per turn; mock chunks are
  // turn-specific. `turn` is 1-indexed at the call site; the pick
  // function modulo'd over the script — both runReplay and the
  // interactive loop pass (turn - 1) so question and chunks align.
  const reply = pickReply(turn - 1);
  const adapter = createStreamingMockAdapter({
    chunks: [...reply.chunks],
    usage: { inputTokens: 60 + question.length, outputTokens: 80 },
  });

  // Wire AbortSignal so Ctrl+C cancels this turn.
  const ctrl = new AbortController();
  abortInFlight = ctrl;

  const loop = new AgentLoop({
    adapter,
    streaming: true,
    maxIterations: 1,
    maxTotalTokens: 20_000,
    signal: ctrl.signal,
    traceManager: traces,
  });

  const messages: Message[] = [...history, { role: 'user', content: question }];
  let answer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let doneReason = 'unknown';
  let aborted = false;

  try {
    for await (const event of loop.run(messages)) {
      switch (event.type) {
        case 'text_delta':
          if (event.text) {
            stdout.write(event.text);
            answer += event.text;
          }
          break;
        case 'message':
          inputTokens = event.usage.inputTokens;
          outputTokens = event.usage.outputTokens;
          break;
        case 'done':
          doneReason = event.reason;
          if (event.totalUsage) {
            // Streaming `done` carries totalUsage; prefer it over per-message.
            inputTokens = event.totalUsage.inputTokens;
            outputTokens = event.totalUsage.outputTokens;
          }
          break;
        case 'error':
          if (ctrl.signal.aborted) {
            aborted = true;
          } else {
            console.error(`\n[error] ${event.error.message}`);
          }
          break;
        default:
          break;
      }
    }
  } finally {
    abortInFlight = null;
  }

  // Record cost so the end-of-session report is accurate.
  costs.recordUsage({
    traceId: `turn-${turn}`,
    model: 'mock-stream',
    inputTokens,
    outputTokens,
  });

  if (!aborted) stdout.write('\n');
  return { answer, inputTokens, outputTokens, doneReason };
}

// ── Mode 1: interactive REPL ───────────────────────────────────────────────
async function runInteractive(): Promise<number> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log('streaming-cli (showcase 01) — interactive');
  console.log('type "exit" or Ctrl+D to leave; Ctrl+C cancels current turn');
  const history: Message[] = [];
  let turn = 0;
  while (!draining) {
    let line: string;
    try {
      line = (await rl.question('\n> ')).trim();
    } catch {
      break; // Ctrl+D
    }
    if (!line) continue;
    if (line === 'exit') break;

    turn += 1;
    const start = Date.now();
    let result: Awaited<ReturnType<typeof runTurn>>;
    try {
      result = await runTurn(turn, line, history);
    } catch (err) {
      console.error(`[turn ${turn}] failed:`, err);
      continue;
    }
    const wallClockMs = Date.now() - start;
    history.push({ role: 'user', content: line });
    history.push({ role: 'assistant', content: result.answer });
    turnLog.push({
      turn,
      question: line,
      answer: result.answer,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: 0,
      wallClockMs,
      doneReason: result.doneReason as TurnSummary['doneReason'],
    });
  }
  rl.close();
  if (!draining) {
    draining = true;
    return shutdown('user_exit');
  }
  return 0;
}

// ── Mode 2: deterministic replay (CI) ──────────────────────────────────────
async function runReplay(): Promise<number> {
  console.log(`streaming-cli (showcase 01) — replay (${REPLAY_TURNS} turns)`);
  const history: Message[] = [];
  for (let turn = 1; turn <= REPLAY_TURNS; turn++) {
    // turn is 1-indexed; pickReply uses 0-indexed turns (modulo) so
    // both the question and the chunks line up to the same scripted
    // entry. runTurn() picks chunks via the same turn argument; pass
    // (turn - 1) here so question[i] is paired with chunks[i].
    const reply = pickReply(turn - 1);
    const question = reply.question;
    process.stdout.write(`\n> ${question}\n`);
    const start = Date.now();
    const result = await runTurn(turn, question, history);
    const wallClockMs = Date.now() - start;
    history.push({ role: 'user', content: question });
    history.push({ role: 'assistant', content: result.answer });
    turnLog.push({
      turn,
      question,
      answer: result.answer,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: 0,
      wallClockMs,
      doneReason: result.doneReason as TurnSummary['doneReason'],
    });
  }
  draining = true;
  return shutdown('replay_complete');
}

// ── Entry ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  bindSignalHandlers();
  const code = REPLAY_MODE ? await runReplay() : await runInteractive();
  process.exit(code);
}

main().catch((err: unknown) => {
  console.error('[showcase-01] fatal:', err);
  process.exit(1);
});
