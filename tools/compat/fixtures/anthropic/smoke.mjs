// Cross-version smoke test for @harness-one/anthropic.
//
// Exercises the adapter against whatever @anthropic-ai/sdk version the
// compat matrix installed. We import the *real* SDK so any missing/
// renamed symbol the adapter might transitively depend on shows up as
// a load-time error before the mock client runs.
//
// The actual network layer is replaced by a duck-typed fake so the
// smoke test can run in CI without an API key.

import assert from 'node:assert/strict';

// If the adapter reaches for any symbol from the SDK at import time
// (e.g. error classes for `instanceof` checks), this import must
// succeed on every matrix version.
import Anthropic from '@anthropic-ai/sdk';
assert.equal(typeof Anthropic, 'function', 'Anthropic default export must be a constructor');

import { createAnthropicAdapter } from '@harness-one/anthropic';

// ---- fake Anthropic client (duck-typed) ----------------------------------
//
// The adapter touches exactly one method: `client.messages.create(...)`.
// Everything else on the SDK surface is unused by the chat path, so the
// fake only needs to implement that.

function makeFakeClient() {
  return {
    messages: {
      async create(_params, _opts) {
        return {
          id: 'msg_compat_smoke',
          type: 'message',
          role: 'assistant',
          model: _params.model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 3, output_tokens: 1 },
        };
      },
    },
  };
}

async function main() {
  const adapter = createAnthropicAdapter({
    client: makeFakeClient(),
    model: 'claude-sonnet-4-20250514',
  });

  assert.equal(typeof adapter.chat, 'function', 'adapter must expose chat()');
  assert.match(adapter.name, /^anthropic:/, 'adapter.name must be namespaced');

  const resp = await adapter.chat({
    messages: [{ role: 'user', content: 'ping' }],
  });

  assert.ok(resp, 'chat() must return a response');
  assert.equal(resp.message.role, 'assistant', 'response role must be assistant');
  assert.equal(resp.message.content, 'ok', 'response content round-trip');
  assert.ok(resp.usage, 'response must carry usage info');

  console.log(
    `smoke-anthropic: OK (sdk ${Anthropic?.VERSION ?? 'unknown'}) — chat round-trip returned "${resp.message.content}"`,
  );
}

main().catch((err) => {
  console.error('smoke-anthropic: FAIL');
  console.error(err);
  process.exit(1);
});
