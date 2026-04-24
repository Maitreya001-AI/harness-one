#!/usr/bin/env node
/**
 * Smoke test — real-provider sanity check for `@harness-one/anthropic` and
 * `@harness-one/openai`.
 *
 * Does NOT run in CI. It makes live API calls and is budget-sensitive
 * (target: each invocation costs < $0.01 against today's prices). Run it
 * locally after touching adapter internals or after recording cassettes,
 * as a final "is the wiring still real?" check.
 *
 * Usage:
 *   pnpm smoke                             # both providers
 *   pnpm smoke -- --only=anthropic         # only one
 *   pnpm smoke -- --only=openai
 *
 * Env:
 *   ANTHROPIC_API_KEY — required for Anthropic leg
 *   OPENAI_API_KEY    — required for OpenAI leg
 *   Both are read from the process env; the harness does not load dotenv
 *   automatically. Use `dotenv -e .env.local --` to inject `.env.local`.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';

// Tiny `.env.local` loader — zero-dep, only touches the file if present so
// CI environments that inject secrets via the process env are unaffected.
async function loadEnvLocal() {
  const path = resolve(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  const raw = await readFile(path, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

function parseArgs() {
  const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  return {
    only: only === 'anthropic' || only === 'openai' ? only : undefined,
  };
}

function classify(err) {
  const name = err?.name ?? err?.constructor?.name ?? 'UnknownError';
  const code = err?.code ?? err?.status ?? err?.statusCode;
  const message = err?.message ?? String(err);
  return { name, code, message };
}

async function smokeAnthropic() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { createAnthropicAdapter } = await import('@harness-one/anthropic');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const adapter = createAnthropicAdapter({
    client,
    // Haiku is the cheapest Anthropic SKU available — keep smoke bill < $0.001.
    model: 'claude-3-5-haiku-20241022',
  });

  console.log('\n── anthropic · chat() ────────────────────────────────');
  const chat = await adapter.chat({
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
    config: { temperature: 0, maxTokens: 16 },
  });
  console.log('  message:', JSON.stringify(chat.message));
  console.log('  usage  :', JSON.stringify(chat.usage));

  console.log('\n── anthropic · stream() ──────────────────────────────');
  const chunks = [];
  for await (const c of adapter.stream({
    messages: [{ role: 'user', content: 'Count to three.' }],
    config: { temperature: 0, maxTokens: 32 },
  })) {
    chunks.push(c);
  }
  const text = chunks.filter((c) => c.type === 'text_delta').map((c) => c.text).join('');
  const done = chunks.find((c) => c.type === 'done');
  console.log('  chunks :', chunks.length, 'text:', JSON.stringify(text));
  console.log('  usage  :', JSON.stringify(done?.usage));
}

async function smokeOpenAI() {
  const { default: OpenAI } = await import('openai');
  const { createOpenAIAdapter } = await import('@harness-one/openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const adapter = createOpenAIAdapter({
    client,
    // gpt-4o-mini is the cheapest 4o SKU; keep smoke bill < $0.001.
    model: 'gpt-4o-mini',
  });

  console.log('\n── openai · chat() ───────────────────────────────────');
  const chat = await adapter.chat({
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
    config: { temperature: 0, maxTokens: 16 },
  });
  console.log('  message:', JSON.stringify(chat.message));
  console.log('  usage  :', JSON.stringify(chat.usage));

  console.log('\n── openai · stream() ─────────────────────────────────');
  const chunks = [];
  for await (const c of adapter.stream({
    messages: [{ role: 'user', content: 'Count to three.' }],
    config: { temperature: 0, maxTokens: 32 },
  })) {
    chunks.push(c);
  }
  const text = chunks.filter((c) => c.type === 'text_delta').map((c) => c.text).join('');
  const done = chunks.find((c) => c.type === 'done');
  console.log('  chunks :', chunks.length, 'text:', JSON.stringify(text));
  console.log('  usage  :', JSON.stringify(done?.usage));
}

async function main() {
  await loadEnvLocal();
  const { only } = parseArgs();

  const runs = [];
  if ((!only || only === 'anthropic')) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('skip anthropic: ANTHROPIC_API_KEY not set');
    } else {
      runs.push(['anthropic', smokeAnthropic]);
    }
  }
  if ((!only || only === 'openai')) {
    if (!process.env.OPENAI_API_KEY) {
      console.error('skip openai: OPENAI_API_KEY not set');
    } else {
      runs.push(['openai', smokeOpenAI]);
    }
  }

  if (runs.length === 0) {
    console.error('\nNo provider selected — add API keys to .env.local or pass --only=<anthropic|openai>.');
    exit(1);
  }

  let failed = 0;
  for (const [name, fn] of runs) {
    try {
      await fn();
      console.log(`\n✔ ${name} smoke ok`);
    } catch (err) {
      failed++;
      console.error(`\n✖ ${name} smoke failed`);
      console.error('  class:', classify(err));
      if (err?.stack) console.error(err.stack);
    }
  }
  exit(failed === 0 ? 0 : 1);
}

await main();
