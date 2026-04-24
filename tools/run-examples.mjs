#!/usr/bin/env node
// Smoke-execute every example under examples/ via tsx.
//
// Goals:
//   - Prove each example is wired correctly end-to-end, not just type-checked.
//   - Skip cleanly when an example requires a peer SDK or live API key that
//     isn't available in CI. Track E explicitly forbids modifying example
//     source to accept mock injection, so classification is done by scanning
//     the file for peer-SDK imports + well-known API-key env refs.
//
// Pass criteria (per example):
//   - Process exit code 0.
//   - No unhandled rejection on stderr.
//   - Completes within PER_EXAMPLE_TIMEOUT_MS (default 10s).
//
// Set HARNESS_MOCK=1 (CI default via pnpm script) to make the skip list
// authoritative and surface "SKIP: <path> needs real adapter" messages.
//
// TODO: When Track C cassette infra lands at packages/core/src/testing/cassette
// the current SKIP list for peer-SDK examples can be narrowed — cassette
// adapter replay removes the need for a live key without touching example
// source. See docs/testing-plan/P0-C-contract-cassette.md.

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const examplesDir = resolve(repoRoot, 'examples');

const PER_EXAMPLE_TIMEOUT_MS = Number(process.env.EXAMPLE_TIMEOUT_MS ?? 10_000);
const HARNESS_MOCK = process.env.HARNESS_MOCK === '1';

// Peer-SDK module names that are NOT installed in the examples workspace
// (they're modelled as `any` via examples/shims.d.ts for typecheck only).
// Any example importing these cannot execute without a real install.
const PEER_SDK_IMPORTS = [
  '@anthropic-ai/sdk',
  'openai',
  'langfuse',
  'ioredis',
  'tiktoken',
  'ajv',
  'ajv-formats',
  '@pinecone-database/pinecone',
  '@opentelemetry/api',
  '@opentelemetry/sdk-trace-base',
];

// Env vars that, when referenced, indicate the example needs a real provider.
const LIVE_API_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'PINECONE_API_KEY',
  'REDIS_URL',
];

/** Return `{ skip: true, reason }` if the file requires external resources. */
async function classifyExample(filePath) {
  const source = await readFile(filePath, 'utf8');

  for (const mod of PEER_SDK_IMPORTS) {
    // Match `from 'mod'` / `from "mod"` / `import('mod')`. Quoted + word-boundary
    // avoids false positives on comments like "install @anthropic-ai/sdk".
    const re = new RegExp(`from\\s+['"]${mod.replace(/[/\-]/g, '\\$&')}['"]`);
    if (re.test(source)) {
      return { skip: true, reason: `imports peer SDK "${mod}" (not installed)` };
    }
  }

  for (const envVar of LIVE_API_ENV_VARS) {
    const re = new RegExp(`process\\.env\\.${envVar}\\b`);
    if (re.test(source)) {
      return { skip: true, reason: `references process.env.${envVar}` };
    }
  }

  return { skip: false };
}

/** Execute one example with tsx. Resolves with `{ status, ... }`. */
function executeExample(filePath) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      'pnpm',
      ['exec', 'tsx', filePath],
      {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, PER_EXAMPLE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ status: 'fail', reason: `spawn error: ${err.message}`, stdout, stderr });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolvePromise({
          status: 'fail',
          reason: `timed out after ${PER_EXAMPLE_TIMEOUT_MS}ms`,
          stdout,
          stderr,
        });
        return;
      }
      if (code !== 0) {
        resolvePromise({
          status: 'fail',
          reason: `exit ${code}${signal ? ` (signal ${signal})` : ''}`,
          stdout,
          stderr,
        });
        return;
      }
      // Catch unhandled rejections logged to stderr even when exit code is 0
      // (Node 20+ sets the exit code, but guard explicitly anyway).
      if (/UnhandledPromiseRejection|Unhandled promise rejection/.test(stderr)) {
        resolvePromise({
          status: 'fail',
          reason: 'unhandled rejection on stderr',
          stdout,
          stderr,
        });
        return;
      }
      resolvePromise({ status: 'pass', stdout, stderr });
    });
  });
}

async function findExamples() {
  // Node 18.17+ / 20.1+ supports `recursive: true`. CI matrix is 18/20/22
  // so we're safe to use it instead of pulling in a glob dep.
  const entries = await readdir(examplesDir, { recursive: true, withFileTypes: true });
  const out = [];
  // Directories under examples/ that should not be treated as example sources.
  const skipDirs = [
    `${examplesDir}/node_modules`,
    `${examplesDir}/dist`,
    // tmp/ holds auto-generated README-snippet scratch files from
    // tools/check-readme-snippets.mjs; they are not standalone examples.
    `${examplesDir}/tmp`,
  ];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    const absPath = resolve(entry.parentPath ?? entry.path, entry.name);
    if (skipDirs.some((prefix) => absPath.startsWith(`${prefix}/`))) continue;
    out.push(relative(repoRoot, absPath));
  }
  return out.sort();
}

async function main() {
  const files = await findExamples();

  if (files.length === 0) {
    console.error('No examples found under examples/**/*.ts');
    process.exit(1);
  }

  console.log(
    `Running ${files.length} example(s) with HARNESS_MOCK=${HARNESS_MOCK ? '1' : '0'}, ` +
      `timeout=${PER_EXAMPLE_TIMEOUT_MS}ms\n`,
  );

  const results = { pass: [], skip: [], fail: [] };

  for (const rel of files) {
    const abs = resolve(repoRoot, rel);
    const display = relative(examplesDir, abs) || rel;

    const classification = await classifyExample(abs);
    if (classification.skip) {
      console.log(`SKIP  ${display} — ${classification.reason}`);
      results.skip.push({ file: rel, reason: classification.reason });
      continue;
    }

    process.stdout.write(`RUN   ${display} ... `);
    const result = await executeExample(abs);
    if (result.status === 'pass') {
      console.log('ok');
      results.pass.push({ file: rel });
    } else {
      console.log(`FAIL (${result.reason})`);
      if (result.stderr) {
        console.log('--- stderr ---');
        console.log(result.stderr.trim().slice(-2000));
      }
      if (result.stdout) {
        console.log('--- stdout ---');
        console.log(result.stdout.trim().slice(-500));
      }
      results.fail.push({ file: rel, reason: result.reason });
    }
  }

  console.log(
    `\nDone: ${results.pass.length} passed, ` +
      `${results.skip.length} skipped, ${results.fail.length} failed ` +
      `(of ${files.length})`,
  );

  if (results.fail.length > 0) {
    console.log('\nFailed examples:');
    for (const { file, reason } of results.fail) {
      console.log(`  - ${file}: ${reason}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
