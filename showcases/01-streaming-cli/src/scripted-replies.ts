/**
 * Deterministic streaming replies used by the showcase under
 * `--replay` / CI mode.
 *
 * Production readers swap in a real Anthropic / OpenAI streaming adapter.
 */
import type { StreamChunk } from 'harness-one/core';

interface ScriptedReply {
  readonly question: string;
  readonly chunks: readonly StreamChunk[];
}

function textChunks(s: string, splitEvery = 6): StreamChunk[] {
  const out: StreamChunk[] = [];
  for (let i = 0; i < s.length; i += splitEvery) {
    out.push({ type: 'text_delta', text: s.slice(i, i + splitEvery) });
  }
  // Mirror production streaming providers: the terminal `done` chunk
  // carries TokenUsage. Without this AgentLoop's cumulative usage stays
  // at zero in streaming mode (see FRICTION_LOG entry on
  // createStreamingMockAdapter usage defaults).
  const inputTokens = 30 + Math.floor(s.length / 4);
  const outputTokens = Math.max(1, Math.ceil(s.length / 4));
  out.push({ type: 'done', usage: { inputTokens, outputTokens } });
  return out;
}

const reply = (question: string, body: string): ScriptedReply => ({
  question,
  chunks: textChunks(body),
});

export const SCRIPTED_REPLIES: readonly ScriptedReply[] = [
  reply(
    'what does AgentLoop guarantee about streaming?',
    'AgentLoop normalizes the adapter\'s stream() into typed events:'
    + ' text_delta, tool_call_delta, and a terminal done with TokenUsage.'
    + ' If done never arrives the loop treats the stream as truncated.',
  ),
  reply(
    'how do I cancel a running turn?',
    'Trigger an AbortSignal — AgentLoop wires it through to the adapter\'s'
    + ' fetch layer so an in-flight request actually stops, not just the JS'
    + ' iteration. The next iteration observes signal.aborted and exits.',
  ),
  reply(
    'tell me about graceful shutdown.',
    'On SIGINT/SIGTERM the lifecycle moves init → ready → draining → shutdown.'
    + ' Trace exporter flushes, cost tracker prints final totals, then process'
    + ' exits 0. A second signal during draining force-exits with code 1.',
  ),
];

/** Pick the next scripted reply, looping when exhausted. */
export function pickReply(turnIndex: number): ScriptedReply {
  const r = SCRIPTED_REPLIES[turnIndex % SCRIPTED_REPLIES.length];
  if (!r) throw new Error('scripted-replies: empty');
  return r;
}

/** Total turns the replay session will run before requesting exit. */
export const REPLAY_TURNS = SCRIPTED_REPLIES.length;
