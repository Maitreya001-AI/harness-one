/**
 * Eval-harness runner.
 *
 * Materialises each fixture's workspace into a temp directory, builds a
 * fresh `CodingAgent` against the caller's adapter factory, runs the
 * task, and collects the verifier verdict. Fixtures execute serially —
 * coding tasks are slow + side-effectful so parallelism would obscure
 * cost / latency reporting.
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentAdapter } from 'harness-one/core';

import {
  createCodingAgent,
  type CreateCodingAgentOptions,
} from '../agent/index.js';
import type {
  EvalCaseResult,
  EvalFixture,
  EvalRunResult,
} from './types.js';

export interface EvalRunOptions {
  readonly fixtures: readonly EvalFixture[];
  /**
   * Build a fresh adapter per fixture. Receives the fixture so callers
   * can scope cassettes/recordings/budgets per case.
   */
  readonly adapterFor: (fixture: EvalFixture) => AgentAdapter | Promise<AgentAdapter>;
  /** Filter fixtures by tag. Empty filter runs every fixture. */
  readonly tagFilter?: readonly string[];
  /** Override agent options (e.g. tighten approval/budget for CI). */
  readonly agentOverrides?: Partial<CreateCodingAgentOptions>;
  /** Optional event sink — fires once per fixture as it completes. */
  readonly onCase?: (result: EvalCaseResult) => void;
}

export async function runEval(options: EvalRunOptions): Promise<EvalRunResult> {
  const cases: EvalCaseResult[] = [];
  const fixtures = applyTagFilter(options.fixtures, options.tagFilter);
  let totalCostUsd = 0;
  let totalTokens = 0;
  let totalDurationMs = 0;

  for (const fixture of fixtures) {
    const result = await runOne(fixture, options);
    cases.push(result);
    totalCostUsd += result.result.cost.usd;
    totalTokens += result.result.cost.tokens;
    totalDurationMs += result.durationMs;
    options.onCase?.(result);
  }

  const passCount = cases.filter((c) => c.pass).length;
  return {
    cases,
    passCount,
    failCount: cases.length - passCount,
    passRate: cases.length === 0 ? 0 : passCount / cases.length,
    totalCostUsd,
    totalTokens,
    totalDurationMs,
  };
}

async function runOne(
  fixture: EvalFixture,
  options: EvalRunOptions,
): Promise<EvalCaseResult> {
  const startedAt = Date.now();
  const workspace = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), `cagent-eval-${sanitize(fixture.id)}-`)),
  );
  const checkpointDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), `cagent-eval-cp-${sanitize(fixture.id)}-`)),
  );
  try {
    await materialiseWorkspace(workspace, fixture.workspace);

    const adapter = await options.adapterFor(fixture);
    const agentOptions: CreateCodingAgentOptions = {
      adapter,
      workspace,
      checkpointDir,
      approval: 'auto',
      // Disable filesystem tracing inside the eval — the runner is the
      // authoritative source of truth for the report.
      traceExporters: [],
      ...(fixture.budget !== undefined && { budget: fixture.budget }),
      ...options.agentOverrides,
    };
    const agent = await createCodingAgent(agentOptions);

    let verdict;
    try {
      const result = await agent.runTask({ prompt: fixture.prompt });
      try {
        verdict = await fixture.verify({ workspace, result });
      } catch (err) {
        verdict = {
          pass: false,
          reason: `verifier threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return {
        fixtureId: fixture.id,
        pass: verdict.pass,
        ...(verdict.reason !== undefined && { reason: verdict.reason }),
        ...(verdict.details !== undefined && { details: verdict.details }),
        result,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await agent.shutdown();
    }
  } finally {
    await Promise.all([
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(checkpointDir, { recursive: true, force: true }),
    ]);
  }
}

async function materialiseWorkspace(
  workspace: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    if (rel.includes('..')) {
      throw new Error(`Fixture file path may not contain "..": ${rel}`);
    }
    const target = path.join(workspace, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
}

function applyTagFilter(
  fixtures: readonly EvalFixture[],
  tagFilter: readonly string[] | undefined,
): readonly EvalFixture[] {
  if (!tagFilter || tagFilter.length === 0) return fixtures;
  const want = new Set(tagFilter);
  return fixtures.filter((f) => f.tags?.some((t) => want.has(t)));
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}
