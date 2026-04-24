#!/usr/bin/env node
/**
 * Cassette re-recorder — plays every {@link CONTRACT_FIXTURES} scenario
 * through the real Anthropic and OpenAI adapters and writes the output
 * to `packages/<adapter>/tests/cassettes/<fixture>.jsonl`.
 *
 * Intended for:
 *   - Local owner regen after touching an adapter.
 *   - The nightly `cassette-drift` GitHub workflow.
 *
 * Usage:
 *   pnpm build --filter harness-one     # cassettes load CONTRACT_FIXTURES from dist
 *   node tools/record-cassettes.mjs --adapter=anthropic
 *   node tools/record-cassettes.mjs --adapter=openai
 *   node tools/record-cassettes.mjs      # both, if both keys present
 *
 * Requires:
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY in env or in .env.local. The
 *   loader is the same zero-dep helper used by `tools/smoke-test.mjs`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';

import {
  CONTRACT_FIXTURES,
  cassetteFileName,
  recordCassette,
} from 'harness-one/testing';

async function loadEnvLocal() {
  const path = resolve(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

function parseArgs() {
  const only = argv.find((a) => a.startsWith('--adapter='))?.slice('--adapter='.length);
  return { only };
}

function ensureDir(path) {
  // `recursive: true` is idempotent — no existsSync race needed.
  mkdirSync(dirname(path), { recursive: true });
}

async function recordAdapter({ label, adapterFactory, cassetteDir }) {
  console.log(`\n── recording ${label} → ${cassetteDir}`);
  const raw = await adapterFactory();
  for (const fx of CONTRACT_FIXTURES) {
    const file = resolve(cassetteDir, cassetteFileName(fx));
    ensureDir(file);
    // Fresh cassette per run — truncate atomically (default 'w' flag both
    // creates and truncates, which avoids the exists-then-unlink-then-write
    // TOCTOU that was here before).
    writeFileSync(file, '', 'utf8');
    const wrapped = recordCassette(raw, file);
    console.log(`  · ${fx.name}`);
    if (fx.kind === 'chat') {
      await wrapped.chat(fx.params);
    } else {
      for await (const _ of wrapped.stream(fx.params)) { /* drain */ }
    }
  }
}

async function buildAnthropic() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { createAnthropicAdapter } = await import('@harness-one/anthropic');
  return createAnthropicAdapter({
    client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    model: 'claude-3-5-haiku-20241022',
  });
}

async function buildOpenAI() {
  const { default: OpenAI } = await import('openai');
  const { createOpenAIAdapter } = await import('@harness-one/openai');
  return createOpenAIAdapter({
    client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    model: 'gpt-4o-mini',
  });
}

async function main() {
  await loadEnvLocal();
  const { only } = parseArgs();

  const jobs = [];
  if ((!only || only === 'anthropic') && process.env.ANTHROPIC_API_KEY) {
    jobs.push({
      label: 'anthropic',
      adapterFactory: buildAnthropic,
      cassetteDir: resolve(process.cwd(), 'packages/anthropic/tests/cassettes'),
    });
  }
  if ((!only || only === 'openai') && process.env.OPENAI_API_KEY) {
    jobs.push({
      label: 'openai',
      adapterFactory: buildOpenAI,
      cassetteDir: resolve(process.cwd(), 'packages/openai/tests/cassettes'),
    });
  }

  if (jobs.length === 0) {
    console.error('No adapter selected — export API keys or pass --adapter=<anthropic|openai>.');
    process.exit(1);
  }

  for (const job of jobs) await recordAdapter(job);
  console.log('\ndone.');
}

await main();
