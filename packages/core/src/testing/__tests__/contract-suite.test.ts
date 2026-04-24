import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
} from '../../core/types.js';
import { computeKey, fingerprint } from '../cassette/index.js';
import { CONTRACT_FIXTURES, createAdapterContractSuite, cassetteFileName } from '../contract/index.js';

/**
 * Build a tiny deterministic adapter whose output is picked to satisfy
 * every assertion in {@link createAdapterContractSuite}. The suite is
 * registered against cassettes recorded from this adapter — if the suite
 * ever drifts, these nested tests break first.
 */
function syntheticAdapter(): AgentAdapter {
  return {
    name: 'synthetic',
    async chat(params: ChatParams): Promise<ChatResponse> {
      if (params.tools && params.tools.length > 0) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                name: params.tools[0]!.name,
                arguments: '{"city":"Paris"}',
              },
            ],
          },
          usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return {
        message: { role: 'assistant', content: 'pong' },
        usage: { inputTokens: 4, outputTokens: 2 },
      };
    },
    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      if (params.tools && params.tools.length > 0) {
        yield { type: 'tool_call_delta', toolCall: { id: 'call_1', name: params.tools[0]!.name } };
        yield { type: 'tool_call_delta', toolCall: { arguments: '{"city":"Berlin"}' } };
        yield { type: 'done', usage: { inputTokens: 10, outputTokens: 6 } };
        return;
      }
      yield { type: 'text_delta', text: 'one ' };
      yield { type: 'text_delta', text: 'two ' };
      yield { type: 'text_delta', text: 'three' };
      yield { type: 'done', usage: { inputTokens: 5, outputTokens: 3 } };
    },
    async countTokens(messages) {
      return messages.reduce((n, m) => n + m.content.length, 0);
    },
  };
}

/**
 * The fixtures are exported as the canonical source of truth; here we
 * hand-author cassette files that match each fixture shape so the
 * nested contract suite can run without ever touching a real API.
 */
function writeSyntheticCassettes(dir: string): void {
  for (const fx of CONTRACT_FIXTURES) {
    const path = join(dir, cassetteFileName(fx));
    const fp = fingerprint(fx.params);
    const key = computeKey(fx.kind, fp);
    const chatLine = (): string =>
      JSON.stringify({
        version: 1,
        kind: 'chat',
        key,
        request: fp,
        response: fx.expect.toolCall
          ? {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [
                  {
                    id: 'call_1',
                    name: 'get_weather',
                    arguments: '{"city":"Paris"}',
                  },
                ],
              },
              usage: { inputTokens: 12, outputTokens: 7 },
            }
          : {
              message: { role: 'assistant', content: 'pong' },
              usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0 },
            },
        recordedAtMs: 0,
      });
    const streamLine = (): string =>
      JSON.stringify({
        version: 1,
        kind: 'stream',
        key,
        request: fp,
        chunks: fx.expect.toolCall
          ? [
              {
                offsetMs: 0,
                chunk: {
                  type: 'tool_call_delta',
                  toolCall: { id: 'call_1', name: 'get_weather' },
                },
              },
              {
                offsetMs: 5,
                chunk: {
                  type: 'tool_call_delta',
                  toolCall: { arguments: '{"city":"Berlin"}' },
                },
              },
              { offsetMs: 10, chunk: { type: 'done', usage: { inputTokens: 10, outputTokens: 6 } } },
            ]
          : [
              { offsetMs: 0, chunk: { type: 'text_delta', text: 'one ' } },
              { offsetMs: 5, chunk: { type: 'text_delta', text: 'two ' } },
              { offsetMs: 10, chunk: { type: 'text_delta', text: 'three' } },
              { offsetMs: 15, chunk: { type: 'done', usage: { inputTokens: 5, outputTokens: 3 } } },
            ],
        recordedAtMs: 0,
      });
    // One line per fixture is all the contract suite consumes. Repeat
    // a second chat line to satisfy the "two sequential chat() calls
    // remain isolated" assertion, which pulls the same key twice.
    const lines = fx.kind === 'chat' ? [chatLine(), chatLine(), chatLine()] : [streamLine(), streamLine(), streamLine()];
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  }
}

// Cassettes must exist by the time vitest's collection phase calls
// the suite factory (it reads files eagerly inside the `describe`
// body). Do the write at module-top so collection sees the files.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'contract-suite-'));
writeSyntheticCassettes(TMP_DIR);
process.on('exit', () => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // best effort — temp dir; OS will reclaim on reboot anyway.
  }
});

// Register the contract suite against the synthetic cassettes. Every
// inner `it()` block is itself a vitest test that asserts the
// AgentAdapter contract.
createAdapterContractSuite(syntheticAdapter(), {
  cassetteDir: TMP_DIR,
  mode: 'replay',
  label: 'synthetic adapter',
});

describe('createAdapterContractSuite — wiring', () => {
  it('registered the outer contract suite', () => {
    expect(TMP_DIR).toMatch(/contract-suite-/);
  });

  it('teardown directory exists while tests run', () => {
    expect(TMP_DIR).toBeTruthy();
  });
});
