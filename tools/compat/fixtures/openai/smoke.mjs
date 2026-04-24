// Cross-version smoke test for @harness-one/openai.
//
// Same shape as the anthropic fixture: import the real SDK at the
// matrix-selected version so any symbol drift surfaces at load time,
// then exercise the adapter against a duck-typed fake client so the
// test doesn't need a live API key.

import assert from 'node:assert/strict';

import OpenAI from 'openai';
assert.equal(typeof OpenAI, 'function', 'OpenAI default export must be a constructor');

import { createOpenAIAdapter } from '@harness-one/openai';

function makeFakeClient() {
  return {
    chat: {
      completions: {
        async create(_params, _opts) {
          return {
            id: 'chatcmpl_compat_smoke',
            object: 'chat.completion',
            created: 0,
            model: _params.model,
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
  const adapter = createOpenAIAdapter({
    client: makeFakeClient(),
    model: 'gpt-4o-mini',
  });

  assert.equal(typeof adapter.chat, 'function', 'adapter must expose chat()');
  assert.match(adapter.name, /^openai:/, 'adapter.name must be namespaced');

  const resp = await adapter.chat({
    messages: [{ role: 'user', content: 'ping' }],
  });

  assert.ok(resp, 'chat() must return a response');
  assert.equal(resp.message.role, 'assistant', 'response role must be assistant');
  assert.equal(resp.message.content, 'ok', 'response content round-trip');
  assert.ok(resp.usage, 'response must carry usage info');

  console.log(
    `smoke-openai: OK (sdk ${OpenAI?.VERSION ?? 'unknown'}) — chat round-trip returned "${resp.message.content}"`,
  );
}

main().catch((err) => {
  console.error('smoke-openai: FAIL');
  console.error(err);
  process.exit(1);
});
