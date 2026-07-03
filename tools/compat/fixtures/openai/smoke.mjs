// Cross-version smoke test for @harness-one/openai.
//
// Same shape as the anthropic fixture: import the real SDK at the
// matrix-selected version so any symbol drift surfaces at load time, then
// exercise the adapter against a duck-typed fake client so the test doesn't
// need a live API key.
//
// What this fixture can HONESTLY verify offline (no network / no real API):
//   1. The installed `openai` version satisfies the declared peer floor
//      (>=4.67.0). This is the first release shipping BOTH features the
//      adapter relies on: `stream_options` (added in openai@4.42.0) and
//      `CompletionUsage.prompt_tokens_details` (added in openai@4.67.0). If a
//      future edit lowers the matrix floor pin below 4.67.0, this assertion
//      fails loudly instead of silently under-reporting streaming cost.
//   2. The adapter's streaming-usage plumbing works end-to-end: when the SDK
//      surfaces a final `include_usage` chunk, the adapter emits a terminal
//      `done` whose `usage.inputTokens` / `usage.outputTokens` are NON-ZERO
//      (the bug the peer-floor raise fixes was zeros here), and the
//      `prompt_tokens_details.cached_tokens` field maps to `cacheReadTokens`.
//
// What it does NOT verify: that the *live* OpenAI service accepts the
// `stream_options` request body — that requires the network. The type-level
// guarantee that `stream_options` / `prompt_tokens_details` are accepted by
// the SDK's types lives in the package `typecheck` job; the floor assertion
// below guarantees the installed SDK is a version where those types exist.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import OpenAI from 'openai';
assert.equal(typeof OpenAI, 'function', 'OpenAI default export must be a constructor');

import { createOpenAIAdapter } from '@harness-one/openai';

const require = createRequire(import.meta.url);

/** Declared peer floor for @harness-one/openai. Keep in sync with package.json. */
const PEER_FLOOR = [4, 67, 0];

/** Semver >= comparison over [major, minor, patch] (prerelease-tolerant). */
function gte(version, floor) {
  const parts = String(version)
    .split('.')
    .map((seg) => parseInt(seg, 10) || 0);
  for (let i = 0; i < floor.length; i++) {
    const a = parts[i] ?? 0;
    const b = floor[i];
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/**
 * Read the installed `openai` version from its package.json. We can't
 * `require('openai/package.json')` because the SDK's `exports` map doesn't
 * expose that subpath, so walk up from the resolved module entry until we find
 * the package's own package.json.
 */
function installedOpenAIVersion() {
  let dir = path.dirname(require.resolve('openai'));
  for (let i = 0; i < 8; i++) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (parsed.name === 'openai' && typeof parsed.version === 'string') {
        return parsed.version;
      }
    } catch {
      // no package.json here (or unreadable) — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not determine the installed openai version');
}

function makeFakeClient() {
  return {
    chat: {
      completions: {
        async create(params, _opts) {
          // Streaming path: mimic the SDK's `stream_options.include_usage`
          // behaviour by emitting a final chunk that carries a `usage` block
          // (including `prompt_tokens_details`).
          if (params && params.stream) {
            return {
              async *[Symbol.asyncIterator]() {
                yield { choices: [{ delta: { content: 'ok' } }] };
                yield {
                  choices: [{ delta: {} }],
                  usage: {
                    prompt_tokens: 11,
                    completion_tokens: 5,
                    total_tokens: 16,
                    prompt_tokens_details: { cached_tokens: 7 },
                  },
                };
              },
            };
          }
          return {
            id: 'chatcmpl_compat_smoke',
            object: 'chat.completion',
            created: 0,
            model: params.model,
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'ok' },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          };
        },
      },
    },
  };
}

async function main() {
  // ── 1. Honest peer-floor gate ────────────────────────────────────────────
  const installedVersion = installedOpenAIVersion();
  assert.ok(
    gte(installedVersion, PEER_FLOOR),
    `installed openai ${installedVersion} does not satisfy the declared peer floor >=${PEER_FLOOR.join('.')} ` +
      '(the floor supports stream_options.include_usage AND prompt_tokens_details)',
  );

  const adapter = createOpenAIAdapter({
    client: makeFakeClient(),
    model: 'gpt-4o-mini',
  });

  assert.equal(typeof adapter.chat, 'function', 'adapter must expose chat()');
  assert.equal(typeof adapter.stream, 'function', 'adapter must expose stream()');
  assert.match(adapter.name, /^openai:/, 'adapter.name must be namespaced');

  // ── 2. chat() round-trip ──────────────────────────────────────────────────
  const resp = await adapter.chat({
    messages: [{ role: 'user', content: 'ping' }],
  });

  assert.ok(resp, 'chat() must return a response');
  assert.equal(resp.message.role, 'assistant', 'response role must be assistant');
  assert.equal(resp.message.content, 'ok', 'response content round-trip');
  assert.ok(resp.usage, 'response must carry usage info');

  // ── 3. stream() usage plumbing must report NON-ZERO tokens ────────────────
  let doneChunk;
  for await (const chunk of adapter.stream({
    messages: [{ role: 'user', content: 'ping' }],
  })) {
    if (chunk.type === 'done') doneChunk = chunk;
  }
  assert.ok(doneChunk, 'stream() must emit a terminal done chunk');
  assert.ok(doneChunk.usage, 'done chunk must carry usage');
  assert.ok(
    doneChunk.usage.inputTokens > 0,
    `streaming inputTokens must be NON-ZERO (include_usage path) — got ${doneChunk.usage.inputTokens}`,
  );
  assert.ok(
    doneChunk.usage.outputTokens > 0,
    `streaming outputTokens must be NON-ZERO — got ${doneChunk.usage.outputTokens}`,
  );
  assert.equal(
    doneChunk.usage.cacheReadTokens,
    7,
    'prompt_tokens_details.cached_tokens must map to cacheReadTokens',
  );

  console.log(
    `smoke-openai: OK (installed openai ${installedVersion} >= ${PEER_FLOOR.join('.')}) — ` +
      `chat round-trip "${resp.message.content}", streaming usage ` +
      `in=${doneChunk.usage.inputTokens} out=${doneChunk.usage.outputTokens} ` +
      `cacheRead=${doneChunk.usage.cacheReadTokens}`,
  );
}

main().catch((err) => {
  console.error('smoke-openai: FAIL');
  console.error(err);
  process.exit(1);
});
