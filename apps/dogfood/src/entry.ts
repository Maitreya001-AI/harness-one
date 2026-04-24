#!/usr/bin/env tsx
/**
 * Dogfood entry point — invoked by `.github/workflows/dogfood-triage.yml`
 * on `issues: opened` events.
 *
 * Contract:
 *   - Always exits 0, even on internal errors. The workflow reads the
 *     emitted report JSON to decide whether to surface a failure.
 *   - Never mutates the original issue except to optionally add a comment
 *     (and, if configured, apply labels).
 *   - Never prints sensitive issue body text to stdout; the fingerprint
 *     hides it from the workflow log.
 */
/* eslint-disable no-console -- CLI entry point; stdout is the product. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AgentAdapter } from 'harness-one/core';

import { readIssueEvent, EventParseError } from './github/event.js';
import { createGhRunner } from './github/gh-cli.js';
import { applyLabels, postIssueComment } from './github/comment.js';
import { defineSearchRecentIssuesTool } from './tools/search-recent-issues.js';
import { buildTriageHarness } from './harness-factory.js';
import { runTriage, VerdictParseError } from './triage/run-triage.js';
import { renderTriageComment } from './triage/render-comment.js';
import { fingerprint, writeRunReport } from './observability/index.js';
import { createMockAdapter } from './mock-adapter.js';
import type { RunReport } from './types.js';

interface EntryEnv {
  readonly eventPath: string;
  readonly repository: string;
  readonly reportsRoot: string;
  readonly dryRun: boolean;
  readonly mocked: boolean;
  readonly applyLabels: boolean;
  readonly model: string;
  readonly anthropicApiKey?: string;
}

function readEnv(env: NodeJS.ProcessEnv): EntryEnv {
  const eventPath = env['GITHUB_EVENT_PATH'];
  const repository = env['GITHUB_REPOSITORY'];
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  return {
    eventPath,
    repository,
    reportsRoot: env['DOGFOOD_REPORTS_ROOT'] ?? resolve(process.cwd(), 'dogfood-reports'),
    dryRun: env['DOGFOOD_DRY_RUN'] === '1',
    mocked: env['DOGFOOD_MOCK'] === '1' || env['ANTHROPIC_API_KEY'] === undefined,
    applyLabels: env['DOGFOOD_APPLY_LABELS'] === '1',
    model: env['DOGFOOD_MODEL'] ?? 'claude-sonnet-4-20250514',
    ...(env['ANTHROPIC_API_KEY'] !== undefined && {
      anthropicApiKey: env['ANTHROPIC_API_KEY'],
    }),
  };
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function buildAdapter(envCfg: EntryEnv): Promise<AgentAdapter> {
  if (envCfg.mocked) {
    return createMockAdapter({
      verdict: {
        suggestedLabels: ['bug', 'needs-repro'],
        duplicates: [],
        reproSteps: [
          'Share the exact harness-one version (pnpm list harness-one).',
          'Attach a minimal reproduction repo or failing test case.',
        ],
        rationale:
          'Mock-mode triage — apply `bug` + `needs-repro` and wait for maintainer review.',
      },
    });
  }

  // Live path: dynamic import so the Anthropic SDK isn't required for mock runs.
  const [{ default: Anthropic }, { createAnthropicAdapter }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('@harness-one/anthropic'),
  ]);
  const client = new Anthropic({ apiKey: envCfg.anthropicApiKey });
  return createAnthropicAdapter({ client, model: envCfg.model });
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<RunReport> {
  const started = Date.now();
  const envCfg = readEnv(env);
  const issue = await readIssueEvent(envCfg.eventPath);
  const harnessVersion = readPackageVersion();
  const gh = createGhRunner({ dryRun: envCfg.dryRun });

  if (issue.isBot) {
    const report: RunReport = {
      schemaVersion: 1,
      harnessVersion,
      timestamp: new Date().toISOString(),
      repository: envCfg.repository,
      issueNumber: issue.number,
      issueBodyFingerprint: fingerprint(issue.body),
      durationMs: Date.now() - started,
      status: 'success',
      cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
      mocked: envCfg.mocked,
    };
    await writeRunReport(envCfg.reportsRoot, report);
    return report;
  }

  const adapter = await buildAdapter(envCfg);
  const harness = buildTriageHarness({ adapter, model: envCfg.model });

  try {
    harness.tools.register(
      defineSearchRecentIssuesTool({ gh, repository: envCfg.repository }) as unknown as Parameters<
        typeof harness.tools.register
      >[0],
    );

    const result = await runTriage(harness, {
      number: issue.number,
      title: issue.title,
      body: issue.body,
    });

    const body = renderTriageComment(result.verdict, {
      harnessVersion,
      traceId: undefined,
      costUsd: result.costUsd,
      mocked: envCfg.mocked,
    });

    if (!envCfg.dryRun) {
      await postIssueComment(gh, {
        repository: envCfg.repository,
        issueNumber: issue.number,
        body,
      });
      if (envCfg.applyLabels && result.verdict.suggestedLabels.length > 0) {
        await applyLabels(gh, {
          repository: envCfg.repository,
          issueNumber: issue.number,
          labels: result.verdict.suggestedLabels,
        });
      }
    }

    const report: RunReport = {
      schemaVersion: 1,
      harnessVersion,
      timestamp: new Date().toISOString(),
      repository: envCfg.repository,
      issueNumber: issue.number,
      issueBodyFingerprint: fingerprint(issue.body),
      durationMs: Date.now() - started,
      status: 'success',
      cost: {
        usd: result.costUsd,
        inputTokens: 0,
        outputTokens: 0,
      },
      verdict: result.verdict,
      mocked: envCfg.mocked,
    };
    await writeRunReport(envCfg.reportsRoot, report);
    return report;
  } catch (err) {
    const isParseError = err instanceof VerdictParseError;
    const report: RunReport = {
      schemaVersion: 1,
      harnessVersion,
      timestamp: new Date().toISOString(),
      repository: envCfg.repository,
      issueNumber: issue.number,
      issueBodyFingerprint: fingerprint(issue.body),
      durationMs: Date.now() - started,
      status: isParseError ? 'guardrail_blocked' : 'error',
      errorCode: isParseError ? 'VERDICT_PARSE_ERROR' : 'UNCAUGHT',
      errorMessage: err instanceof Error ? err.message : String(err),
      cost: { usd: harness.costs.getTotalCost(), inputTokens: 0, outputTokens: 0 },
      mocked: envCfg.mocked,
    };
    await writeRunReport(envCfg.reportsRoot, report);
    return report;
  } finally {
    await harness.shutdown().catch(() => undefined);
  }
}

// Self-invoke when run directly via tsx. Never rethrow; the workflow reads
// the report JSON to decide success.
const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('entry.ts');
if (invokedAsScript) {
  main()
    .then((report) => {
      if (report.status === 'error') {
        console.error(`[dogfood] run ended with error: ${report.errorMessage ?? 'unknown'}`);
      } else {
        console.log(`[dogfood] run ${report.status} (issue #${report.issueNumber})`);
      }
    })
    .catch((err: unknown) => {
      console.error('[dogfood] unhandled top-level failure:', err);
      // Exit 0 deliberately — failure surfaces via the (missing) report.
    });
}

// Support for either `export default` (tsx direct) or Node module resolution.
export { EventParseError, VerdictParseError };
