#!/usr/bin/env node
/**
 * Generate synthetic cassette files for each adapter under
 * `packages/<adapter>/tests/cassettes/`.
 *
 * Why hand-author cassettes at all:
 *   - Real-API re-recording costs money and needs live keys — not a fit
 *     for forks, CI, or contributor PRs.
 *   - We want the contract suite to be deterministic and fast on every
 *     machine out of the box.
 *   - The nightly `cassette-drift` workflow replaces these synthetic
 *     cassettes with live recordings and raises an issue on diff, so
 *     the hand-authored baseline is not a long-term substitute for
 *     real-API evidence — it's the seed that lets the nightly workflow
 *     detect change at all.
 *
 * Usage:
 *   pnpm build --filter harness-one
 *   node tools/generate-synthetic-cassettes.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Import from the built dist directly — the workspace root does not
// depend on `harness-one`, so a bare-specifier import cannot resolve.
// Resolve relative to this file so the tool works from any cwd.
import { fileURLToPath } from 'node:url';
import { dirname as _dirname, resolve as _resolve } from 'node:path';
const __here = _dirname(fileURLToPath(import.meta.url));
const testingMod = _resolve(__here, '..', 'packages/core/dist/testing/index.js');
const {
  CONTRACT_FIXTURES,
  cassetteFileName,
  computeKey,
  fingerprint,
} = await import(testingMod);

const ADAPTERS = [
  { label: 'anthropic', dir: 'packages/anthropic/tests/cassettes' },
  { label: 'openai', dir: 'packages/openai/tests/cassettes' },
];

/**
 * Build a single cassette entry that satisfies the contract assertions
 * for the given fixture. The shape mirrors what a real adapter would
 * produce — we stay adapter-agnostic because the cassette is the
 * AgentAdapter-level fingerprint, not the raw SDK payload.
 */
function entryFor(fx, adapterLabel) {
  const fp = fingerprint(fx.params);
  if (fx.kind === 'chat') {
    const key = computeKey('chat', fp);
    const message = fx.expect.toolCall
      ? {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: adapterLabel === 'anthropic' ? 'toolu_01AB' : 'call_1',
              name: 'get_weather',
              arguments: '{"city":"Paris"}',
            },
          ],
        }
      : {
          role: 'assistant',
          content:
            fx.name === 'chat-simple'
              ? 'pong'
              : fx.name === 'chat-with-system'
                ? 'hi'
                : 'ok',
        };
    return [
      {
        version: 1,
        kind: 'chat',
        key,
        request: fp,
        response: {
          message,
          usage: {
            inputTokens: 12,
            outputTokens: 4,
            ...(adapterLabel === 'anthropic' && { cacheReadTokens: 0, cacheWriteTokens: 0 }),
          },
        },
        recordedAtMs: 0,
      },
    ];
  }
  const key = computeKey('stream', fp);
  const chunks = fx.expect.toolCall
    ? [
        {
          offsetMs: 0,
          chunk: {
            type: 'tool_call_delta',
            toolCall: {
              id: adapterLabel === 'anthropic' ? 'toolu_01CD' : 'call_1',
              name: 'get_weather',
            },
          },
        },
        {
          offsetMs: 5,
          chunk: {
            type: 'tool_call_delta',
            toolCall: { arguments: '{"city":"Berlin"}' },
          },
        },
        {
          offsetMs: 10,
          chunk: { type: 'done', usage: { inputTokens: 18, outputTokens: 9 } },
        },
      ]
    : [
        { offsetMs: 0, chunk: { type: 'text_delta', text: 'one ' } },
        { offsetMs: 5, chunk: { type: 'text_delta', text: 'two ' } },
        { offsetMs: 10, chunk: { type: 'text_delta', text: 'three' } },
        {
          offsetMs: 15,
          chunk: { type: 'done', usage: { inputTokens: 6, outputTokens: 3 } },
        },
      ];
  return [
    {
      version: 1,
      kind: 'stream',
      key,
      request: fp,
      chunks,
      recordedAtMs: 0,
    },
  ];
}

function ensureDir(path) {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

for (const { label, dir } of ADAPTERS) {
  for (const fx of CONTRACT_FIXTURES) {
    const file = resolve(process.cwd(), dir, cassetteFileName(fx));
    ensureDir(file);
    // The contract suite opens the same cassette multiple times (e.g. the
    // "isolation" test creates two adapters reading the same file). Write
    // three identical entries so those tests always find a fresh match.
    const entries = [];
    for (let i = 0; i < 3; i++) entries.push(...entryFor(fx, label));
    const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(file, body, 'utf8');
    console.log(`wrote ${dir}/${cassetteFileName(fx)}  (${entries.length} entries)`);
  }
}
