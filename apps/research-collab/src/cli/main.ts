/**
 * Pure CLI driver — parses argv, builds runtime, runs the pipeline, and
 * persists/prints the report.
 *
 * Separated from `bin.ts` so it's directly testable: the test harness can
 * call `runCli({ argv, env, write, ... })` without spawning a subprocess.
 *
 * Exit-code contract:
 *   0  — success or non-fatal pipeline error (report written)
 *   2  — bad arguments / bad env (no run attempted)
 */

import { CliArgError, parseArgs, printHelp } from './args.js';
import { buildCliRuntime, type BuildRuntimeOptions } from './build-runtime.js';
import { EnvError, readEnv } from './env.js';
import { readVersions } from './version.js';
import { writeRunReport } from '../observability/report-writer.js';
import { runResearch } from '../pipeline/run.js';
import type { ResearchTask, RunReport } from '../types.js';

export interface RunCliOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Stream to which `--print` and status messages are written. */
  readonly stdout?: (text: string) => void;
  /** Stream to which errors are written. */
  readonly stderr?: (text: string) => void;
  /** Override runtime builder for tests. */
  readonly runtimeOptions?: BuildRuntimeOptions;
}

export interface RunCliResult {
  readonly exitCode: 0 | 2;
  readonly report?: RunReport;
}

export async function runCli(options: RunCliOptions): Promise<RunCliResult> {
  const stdout = options.stdout ?? ((s) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s) => process.stderr.write(s));

  let parsed;
  try {
    parsed = parseArgs(options.argv);
  } catch (err) {
    if (err instanceof CliArgError) {
      if (err.message === '__help__') return { exitCode: 0 };
      stderr(`harness-research: ${err.message}\n`);
      printHelp(stderr);
      return { exitCode: 2 };
    }
    throw err;
  }

  let envCfg;
  try {
    envCfg = readEnv(options.env);
  } catch (err) {
    if (err instanceof EnvError) {
      stderr(`harness-research: ${err.message}\n`);
      return { exitCode: 2 };
    }
    throw err;
  }

  const versions = readVersions();
  const runtime = await buildCliRuntime(envCfg, options.runtimeOptions ?? {});

  const task: ResearchTask = {
    question: parsed.question,
    source: 'cli',
  };

  const outcome = await runResearch(task, {
    adapter: runtime.adapter,
    searchProvider: runtime.searchProvider,
    fetcher: runtime.fetcher,
    model: envCfg.model,
    budgetUsd: envCfg.budgetUsd,
    mocked: envCfg.mocked,
    source: 'cli',
    appVersion: versions.app,
    harnessVersion: versions.harness,
  });

  if (!parsed.noReport) {
    const reportsRoot = parsed.reportsRoot ?? envCfg.reportsRoot;
    await writeRunReport(reportsRoot, outcome.report, {
      ...(outcome.pipeline?.report !== undefined && !parsed.skipMarkdown && {
        research: outcome.pipeline.report,
      }),
    });
  }

  if (parsed.print && outcome.pipeline?.report) {
    stdout(outcome.pipeline.report.markdown.endsWith('\n') ? outcome.pipeline.report.markdown : outcome.pipeline.report.markdown + '\n');
  }

  if (outcome.report.status === 'success') {
    stdout(`harness-research: ${outcome.report.runId} success ($${outcome.report.cost.usd.toFixed(4)})\n`);
  } else {
    stderr(
      `harness-research: ${outcome.report.runId} ${outcome.report.status} (${outcome.report.errorCode ?? 'UNCAUGHT'}): ${outcome.report.errorMessage ?? ''}\n`,
    );
  }
  return { exitCode: 0, report: outcome.report };
}
