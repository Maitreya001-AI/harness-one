#!/usr/bin/env node
// Extract every ```ts / ```typescript fenced code block from README.md,
// write them out as standalone .ts files, and run `tsc --noEmit` over them.
//
// Rationale: README is the first code users copy-paste. Broken snippets
// undermine trust even when the library itself is sound. Typechecking in CI
// forces snippets to stay compilable as the public API evolves.
//
// Skipping a snippet: add an HTML comment `<!-- noverify -->` immediately
// before the opening fence. Use sparingly — if skip ratio exceeds
// MAX_SKIP_RATIO (default 30%) CI goes red, guarding against drift toward
// an unverified README.
//
// Writeable scratch dir lives inside the repo (tmp/readme-snippets/) so
// Node's module resolution finds workspace packages (harness-one, @harness-one/*)
// via the root node_modules/.pnpm layout. This is also why we don't write to /tmp.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const readmePath = resolve(repoRoot, 'README.md');
// Scratch dir lives under examples/ so the workspace-linked harness-one /
// @harness-one/* packages resolve via examples/node_modules. Putting it at
// the repo root would break imports because the root package declares none
// of these as dependencies.
const scratchDir = resolve(repoRoot, 'examples/tmp/readme-snippets');
const MAX_SKIP_RATIO = 0.3;

/**
 * Parse README, return array of { lineStart, lang, body, skipped } for each
 * ts/typescript fenced block in order.
 */
function extractSnippets(readme) {
  const lines = readme.split('\n');
  const blocks = [];

  let inBlock = false;
  let currentLang = '';
  let currentStart = 0;
  let currentBody = [];
  let skipNext = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inBlock) {
      // Track <!-- noverify --> marker on its own line immediately preceding a fence.
      if (/<!--\s*noverify\s*-->/.test(line)) {
        skipNext = true;
        continue;
      }
      const openMatch = /^```(\w+)?\s*$/.exec(line);
      if (openMatch) {
        inBlock = true;
        currentLang = (openMatch[1] ?? '').toLowerCase();
        currentStart = i + 1;
        currentBody = [];
        continue;
      }
      // Any non-blank, non-fence line between marker and fence dissolves the marker.
      if (skipNext && line.trim() !== '') skipNext = false;
    } else {
      if (/^```\s*$/.test(line)) {
        if (currentLang === 'ts' || currentLang === 'typescript') {
          blocks.push({
            lineStart: currentStart,
            lang: currentLang,
            body: currentBody.join('\n'),
            skipped: skipNext,
          });
        }
        inBlock = false;
        skipNext = false;
        continue;
      }
      currentBody.push(line);
    }
  }

  return blocks;
}

/**
 * Write a single snippet as its own module. Imports must stay top-level (ESM)
 * and a trailing `export {}` forces tsc to treat the file as a module even
 * when the snippet has no imports/exports of its own.
 */
function wrapSnippet(body, index, line) {
  const safeBody = body.replace(/\r\n/g, '\n');
  return (
    `// Auto-generated from README.md snippet #${index + 1} (line ${line}). Do not edit.\n` +
    `${safeBody}\n` +
    `export {};\n`
  );
}

// Ambient declarations for placeholder identifiers that appear across README
// snippets as "the reader already has one of these" stand-ins. Keeping them
// typed as `any` lets snippets verify their *real* surface — harness-one API
// calls — without forcing each snippet to reconstruct the full setup context.
// If a snippet references a name NOT on this list, tsc surfaces it and we
// either fix the snippet, extend this prelude, or add <!-- noverify -->.
// Ambient declaration file — NO import/export, so tsc treats this as
// global scope and every .ts file sees these names without importing.
const PLACEHOLDER_PRELUDE = `// Auto-generated. See tools/check-readme-snippets.mjs.
// Ambient placeholder declarations for README-snippet continuations.
declare const harness: any;
declare const adapter: any;
declare const yourLLMAdapter: any;
declare const messages: any[];
declare const userId: string;
declare const userMessage: string;
declare const initialContent: string;
declare const output: any;
declare const anthropicClient: any;
declare const conversationHistory: any[];
declare const tenantAChunks: any[];
declare const tenantBChunks: any[];
declare const myTool: any;
declare const myModel: any;
declare const myVerifier: any;
declare const myEventBus: any;
declare const myEmbeddingModel: any;
declare const myTraceManager: any;
declare function callLLM(...args: any[]): Promise<any>;
`;

async function writeTsconfig() {
  const tsconfig = {
    extends: '../../../tsconfig.base.json',
    compilerOptions: {
      noEmit: true,
      rootDir: '.',
      // Snippets are authored for documentation: they reference peer SDKs,
      // have unused variables, and skip exhaustive typing. Relax strictness
      // so the focus stays on surface-API contracts, matching examples/.
      noUnusedLocals: false,
      noUnusedParameters: false,
      noImplicitAny: false,
      exactOptionalPropertyTypes: false,
      skipLibCheck: true,
    },
    // Pull in the examples shims (../../shims.d.ts from this scratch dir)
    // so optional peer SDKs (@anthropic-ai/sdk, openai, langfuse, tiktoken,
    // ioredis, ajv, @pinecone-database/pinecone, @opentelemetry/*) are
    // modelled as `any` without requiring install.
    include: ['**/*.ts', '../../shims.d.ts'],
  };
  await writeFile(
    resolve(scratchDir, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2),
    'utf8',
  );
  await writeFile(
    resolve(scratchDir, '__prelude.d.ts'),
    PLACEHOLDER_PRELUDE,
    'utf8',
  );
}

function runTsc() {
  return new Promise((resolvePromise) => {
    const child = spawn(
      'pnpm',
      ['exec', 'tsc', '--noEmit', '-p', 'examples/tmp/readme-snippets/tsconfig.json'],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('exit', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function main() {
  const readme = await readFile(readmePath, 'utf8');
  const snippets = extractSnippets(readme);

  if (snippets.length === 0) {
    console.error('No ts/typescript snippets found in README.md');
    process.exit(1);
  }

  await rm(scratchDir, { recursive: true, force: true });
  await mkdir(scratchDir, { recursive: true });
  await writeTsconfig();

  const verified = [];
  const skipped = [];
  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i];
    if (snippet.skipped) {
      skipped.push({ index: i + 1, line: snippet.lineStart });
      continue;
    }
    verified.push({ index: i + 1, line: snippet.lineStart });
    const filename = `snippet-${String(i + 1).padStart(3, '0')}.ts`;
    await writeFile(
      resolve(scratchDir, filename),
      wrapSnippet(snippet.body, i, snippet.lineStart),
      'utf8',
    );
  }

  const skipRatio = skipped.length / snippets.length;
  console.log(
    `Found ${snippets.length} ts snippet(s): ${verified.length} to typecheck, ` +
      `${skipped.length} skipped via <!-- noverify --> (${(skipRatio * 100).toFixed(1)}%)`,
  );

  if (skipped.length > 0) {
    const preview = skipped.map((s) => `  - README.md:${s.line} (snippet #${s.index})`).join('\n');
    console.log('Skipped snippets:');
    console.log(preview);
  }

  if (skipRatio > MAX_SKIP_RATIO) {
    console.error(
      `\nSkip ratio ${(skipRatio * 100).toFixed(1)}% exceeds the ` +
        `${(MAX_SKIP_RATIO * 100).toFixed(0)}% limit. README must remain ` +
        `mostly machine-verifiable — drop unnecessary <!-- noverify --> ` +
        `markers or replace opaque snippets with compilable ones.`,
    );
    process.exit(1);
  }

  if (verified.length === 0) {
    console.log('No snippets to verify — nothing to do.');
    return;
  }

  const { code, stdout, stderr } = await runTsc();
  if (code === 0) {
    console.log(`\ntsc --noEmit passed for all ${verified.length} snippet(s) ✓`);
    return;
  }

  console.error('\ntsc reported errors in README snippets:');
  if (stdout) console.error(stdout);
  if (stderr) console.error(stderr);
  console.error(
    '\nTo fix: edit the README snippet, or add an HTML comment ' +
      '`<!-- noverify -->` on the line immediately before the opening fence ' +
      `(budget: <${(MAX_SKIP_RATIO * 100).toFixed(0)}% of snippets).`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
