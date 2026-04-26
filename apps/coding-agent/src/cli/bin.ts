#!/usr/bin/env node
/**
 * `harness-coding` CLI entry point.
 *
 * - Parses argv (see `args.ts`).
 * - Builds an `AgentAdapter` lazily, importing `@harness-one/anthropic`
 *   and `@anthropic-ai/sdk` only when needed (so `--help` and `ls` work
 *   without the SDK installed).
 * - Wires SIGINT/SIGTERM into a single `AbortController` shared with the
 *   agent.
 * - Renders the resulting `TaskResult` to stdout (and optionally a file).
 *
 * @module
 */
 

import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentAdapter } from 'harness-one/core';
import { HarnessError } from 'harness-one/core';

import { createCodingAgent } from '../agent/index.js';
import type { CreateCodingAgentOptions } from '../agent/index.js';
import { HELP_TEXT, parseArgs, type ParsedArgs } from './args.js';
import {
  renderCheckpointList,
  renderEvalReport,
  renderJsonReport,
  renderResult,
} from './output.js';
import { installSignalHandlers } from './signals.js';
import { builtinFixtures, runEval } from '../eval/index.js';

interface MainEnv {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly adapterFactory?: (model?: string, apiKey?: string) => Promise<AgentAdapter>;
}

const VERSION_FALLBACK = '0.0.1';

export async function main(opts: MainEnv): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(opts.argv);
  } catch (err) {
    stderr.write(`${humanize(err)}\n`);
    return 64; // EX_USAGE
  }

  if (parsed.help) {
    stdout.write(HELP_TEXT);
    return 0;
  }
  if (parsed.version) {
    stdout.write(`${readVersion()}\n`);
    return 0;
  }

  if (parsed.listMode) {
    return runList(parsed, stdout, stderr);
  }

  if (parsed.evalMode) {
    return runEvalCommand(parsed, opts, stdout, stderr);
  }

  const wantsRun = parsed.prompt.length > 0 || parsed.resume !== undefined;
  if (!wantsRun) {
    stderr.write('No task description supplied.\n');
    stdout.write(HELP_TEXT);
    return 64;
  }

  const aborter = new AbortController();
  const signals = installSignalHandlers({ aborter });

  try {
    const factory = opts.adapterFactory ?? defaultAdapterFactory;
    const adapter = await factory(parsed.model, opts.env['ANTHROPIC_API_KEY']);

    const agentOptions: CreateCodingAgentOptions = {
      adapter,
      ...(parsed.workspace !== undefined && { workspace: parsed.workspace }),
      ...(parsed.model !== undefined && { model: parsed.model }),
      ...(parsed.approval !== undefined && { approval: parsed.approval }),
      dryRun: parsed.dryRun,
      budget: {
        ...(parsed.maxTokens !== undefined && { tokens: parsed.maxTokens }),
        ...(parsed.maxIterations !== undefined && { iterations: parsed.maxIterations }),
        ...(parsed.maxDurationMs !== undefined && { durationMs: parsed.maxDurationMs }),
      },
    };
    const agent = await createCodingAgent(agentOptions);

    const result = await agent.runTask({
      prompt: parsed.prompt,
      ...(parsed.resume !== undefined && { resumeTaskId: parsed.resume }),
      ...(parsed.planOnly && { planOnly: true }),
      ...(parsed.dryRun && { dryRun: true }),
      signal: aborter.signal,
    });
    await agent.shutdown();

    stdout.write(renderResult(result));
    if (parsed.output) {
      await fs.writeFile(parsed.output, renderJsonReport(result), 'utf8');
      stderr.write(`Wrote report to ${parsed.output}\n`);
    }
    if (result.reason === 'completed') return 0;
    if (result.reason === 'aborted') return 130;
    if (result.reason === 'budget') return 75; // EX_TEMPFAIL — budget hit
    return 1; // 'error'
  } catch (err) {
    stderr.write(`${humanize(err)}\n`);
    return 1;
  } finally {
    signals.cleanup();
  }
}

async function runEvalCommand(
  parsed: ParsedArgs,
  opts: MainEnv,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  try {
    const factory = opts.adapterFactory ?? defaultAdapterFactory;
    const tagFilter = parsed.evalTags;
    const report = await runEval({
      fixtures: builtinFixtures,
      ...(tagFilter.length > 0 && { tagFilter }),
      adapterFor: () => factory(parsed.model, opts.env['ANTHROPIC_API_KEY']),
    });
    stdout.write(renderEvalReport(report));
    if (parsed.output) {
      await fs.writeFile(parsed.output, JSON.stringify(report, null, 2), 'utf8');
      stderr.write(`Wrote eval report to ${parsed.output}\n`);
    }
    return report.failCount === 0 ? 0 : 1;
  } catch (err) {
    stderr.write(`${humanize(err)}\n`);
    return 1;
  }
}

async function runList(
  parsed: ParsedArgs,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  try {
    const agent = await createCodingAgent({
      adapter: STUB_ADAPTER,
      ...(parsed.workspace !== undefined && { workspace: parsed.workspace }),
    });
    const list = await agent.listCheckpoints(50);
    stdout.write(renderCheckpointList(list));
    await agent.shutdown();
    return 0;
  } catch (err) {
    stderr.write(`${humanize(err)}\n`);
    return 1;
  }
}

/**
 * Lazy, dynamic import of `@harness-one/anthropic` so `--help` works without
 * the SDK installed. Defaults the model when the caller didn't override.
 */
async function defaultAdapterFactory(
  model: string | undefined,
  apiKey: string | undefined,
): Promise<AgentAdapter> {
  const [{ default: Anthropic }, { createAnthropicAdapter }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('@harness-one/anthropic'),
  ]);
  const client = new Anthropic({ apiKey });
  return createAnthropicAdapter({
    client,
    ...(model !== undefined && { model }),
  });
}

const STUB_ADAPTER: AgentAdapter = {
  name: 'coding-agent:stub',
  async chat(): Promise<never> {
    throw new Error(
      'No adapter configured. The stub adapter cannot run tasks; supply --resume <id> or set up the live adapter via ANTHROPIC_API_KEY.',
    );
  },
};

function readVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = resolve(here, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? VERSION_FALLBACK;
  } catch {
    return VERSION_FALLBACK;
  }
}

function humanize(err: unknown): string {
  if (err instanceof HarnessError) return `harness-coding: ${err.message}`;
  if (err instanceof Error) return `harness-coding: ${err.message}`;
  return `harness-coding: ${String(err)}`;
}

// Self-invoke when run directly via tsx (the bin script).
const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /coding-agent\/.*bin\.ts$/.test(process.argv[1]);
if (invokedAsScript) {
  main({
    argv: process.argv.slice(2),
    env: process.env,
  })
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${humanize(err)}\n`);
      process.exit(1);
    });
}
