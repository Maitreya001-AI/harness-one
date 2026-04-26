/**
 * Top-level entry that ties harness construction + pipeline orchestration +
 * report generation into a single `runResearch()` call.
 *
 * Used by both the CLI binary and library consumers (tests, future scripts).
 */

import { randomUUID } from 'node:crypto';

import type { AgentAdapter } from 'harness-one/core';
import { omitUndefined } from 'harness-one/infra';

import { buildAgentHarness } from '../harness-factory.js';
import { fingerprint } from '../observability/fingerprint.js';
import { defineWebSearchTool, type WebSearchProvider } from '../tools/web-search.js';
import { defineWebFetchTool, type WebFetcher } from '../tools/web-fetch.js';
import { createWebContentGuardrail } from '../guardrails/web-content.js';
import type {
  AgentCost,
  ResearchTask,
  RunReport,
  RunSource,
  RunStatus,
} from '../types.js';

import { runPipeline, type RunPipelineResult, type SpecialistFactory } from './orchestrator.js';

export interface RunResearchOptions {
  /** LLM adapter every agent shares. */
  readonly adapter: AgentAdapter;
  /** Web search provider injected into each Specialist. */
  readonly searchProvider: WebSearchProvider;
  /** Web fetcher injected into each Specialist. */
  readonly fetcher: WebFetcher;
  /** Override the default model. */
  readonly model?: string;
  /** Per-agent USD budget. */
  readonly budgetUsd?: number;
  /** Bound on concurrent Specialist runs. */
  readonly specialistConcurrency?: number;
  /** Marks the report `mocked: true` when set (mock adapter / fixture web tools). */
  readonly mocked?: boolean;
  /** Origin marker for observability. */
  readonly source?: RunSource;
  /** Harness-one version string captured in the report. */
  readonly harnessVersion: string;
  /** App version captured in the report. */
  readonly appVersion: string;
}

export interface RunResearchOutcome {
  readonly report: RunReport;
  readonly pipeline?: RunPipelineResult;
}

/**
 * Run a single research task end-to-end.
 *
 * Always returns a `RunReport` — Researcher / Coordinator failures classify
 * as `'error'`, guardrail blocks classify as `'guardrail_blocked'`. The
 * caller decides whether to surface to stderr or just persist the report.
 */
export async function runResearch(
  task: ResearchTask,
  options: RunResearchOptions,
): Promise<RunResearchOutcome> {
  const runId = task.id ?? `r${randomUUID()}`;
  const source = task.source ?? options.source ?? 'library';
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();
  const questionFingerprint = fingerprint(task.question);

  // Build per-role harnesses up front so cost slices stay independent.
  const researcherHarness = buildAgentHarness(
    omitUndefined({
      role: 'researcher' as const,
      adapter: options.adapter,
      model: options.model,
      budgetUsd: options.budgetUsd,
    }),
  );
  const coordinatorHarness = buildAgentHarness(
    omitUndefined({
      role: 'coordinator' as const,
      adapter: options.adapter,
      model: options.model,
      budgetUsd: options.budgetUsd,
    }),
  );

  const guardrail = createWebContentGuardrail();

  const specialistFactory: SpecialistFactory = () => {
    const harness = buildAgentHarness(
      omitUndefined({
        role: 'specialist' as const,
        adapter: options.adapter,
        model: options.model,
        budgetUsd: options.budgetUsd,
      }),
    );
    return {
      harness,
      tools: {
        webSearch: defineWebSearchTool(options.searchProvider),
        webFetch: defineWebFetchTool({ fetcher: options.fetcher, guardrail }),
      },
    };
  };

  let outcome: RunPipelineResult | undefined;
  let status: RunStatus = 'success';
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  try {
    outcome = await runPipeline({
      runId,
      question: task.question,
      harnesses: { researcher: researcherHarness, coordinator: coordinatorHarness, specialistFactory },
      ...(options.specialistConcurrency !== undefined && {
        specialistConcurrency: options.specialistConcurrency,
      }),
    });
  } catch (err) {
    status = classifyTopLevelStatus(err);
    errorCode = errorCodeFromError(err);
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    await researcherHarness.shutdown().catch(() => undefined);
    await coordinatorHarness.shutdown().catch(() => undefined);
  }

  const durationMs = Date.now() - startedAt;
  const perAgent: AgentCost[] = outcome
    ? [
        { agent: 'researcher', usd: outcome.costs.researcher },
        { agent: 'specialist', usd: outcome.costs.specialists },
        { agent: 'coordinator', usd: outcome.costs.coordinator },
      ]
    : [];
  const totalCost = outcome?.costs.total ?? 0;

  const report: RunReport = {
    schemaVersion: 1,
    harnessVersion: options.harnessVersion,
    appVersion: options.appVersion,
    timestamp: startedIso,
    runId,
    source,
    questionFingerprint,
    durationMs,
    status,
    ...(errorCode !== undefined && { errorCode }),
    ...(errorMessage !== undefined && { errorMessage }),
    cost: { usd: totalCost, perAgent },
    subQuestions: outcome?.subQuestions ?? [],
    specialists: outcome?.specialistOutcomes ?? [],
    ...(outcome?.report !== undefined && {
      report: {
        summary: outcome.report.summary,
        markdownBytes: new TextEncoder().encode(outcome.report.markdown).byteLength,
        citationCount: outcome.report.citations.length,
      },
    }),
    mocked: options.mocked ?? false,
  };

  return outcome === undefined ? { report } : { report, pipeline: outcome };
}

function classifyTopLevelStatus(err: unknown): RunStatus {
  const msg = err instanceof Error ? err.message : String(err);
  if (/guardrail/i.test(msg)) return 'guardrail_blocked';
  return 'error';
}

function errorCodeFromError(err: unknown): string {
  if (err instanceof Error && err.name) return err.name;
  return 'UNCAUGHT';
}
