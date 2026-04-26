/**
 * Coordinator agent — synthesises Specialist answers into a final report.
 */

import type { SecureHarness } from '@harness-one/preset';

import {
  ParseError,
  parseResearchReport,
  type ParseReportOptions,
} from '../pipeline/parsers.js';
import { buildCoordinatorSystemPrompt, buildCoordinatorUserTurn } from '../prompts/coordinator.js';
import type { ResearchReport, SpecialistAnswer, SubQuestion } from '../types.js';

import { runHarnessLoop } from './run-loop.js';

export interface CoordinatorInput {
  readonly runId: string;
  readonly question: string;
  readonly subQuestions: readonly SubQuestion[];
  readonly answers: readonly SpecialistAnswer[];
}

export interface CoordinatorResult {
  readonly report: ResearchReport;
  readonly costUsd: number;
  readonly assistantMessage: string;
  readonly iterations: number;
}

export class CoordinatorFailure extends Error {
  constructor(
    message: string,
    readonly cause: ParseError | Error,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'CoordinatorFailure';
  }
}

export async function runCoordinator(
  harness: SecureHarness,
  input: CoordinatorInput,
): Promise<CoordinatorResult> {
  const allowedUrls = collectCitedUrls(input.answers);
  const startCost = harness.costs.getTotalCost();

  const { assistantMessage, iterations } = await runHarnessLoop(harness, {
    system: buildCoordinatorSystemPrompt(),
    user: buildCoordinatorUserTurn(input.question, input.subQuestions, input.answers),
    sessionId: `research-${input.runId}-coordinator`,
  });

  let report: ResearchReport;
  try {
    const opts: ParseReportOptions = { allowedUrls };
    report = parseResearchReport(assistantMessage, opts);
  } catch (err) {
    if (err instanceof ParseError) {
      throw new CoordinatorFailure(
        `Coordinator produced invalid output: ${err.message}`,
        err,
        assistantMessage,
      );
    }
    throw err;
  }

  return {
    report,
    costUsd: harness.costs.getTotalCost() - startCost,
    assistantMessage,
    iterations,
  };
}

function collectCitedUrls(answers: readonly SpecialistAnswer[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const answer of answers) {
    for (const c of answer.citations) {
      set.add(c.url);
    }
  }
  return set;
}
