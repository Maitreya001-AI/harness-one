/**
 * Researcher agent — decomposes the user question into subquestions.
 */

import type { SecureHarness } from '@harness-one/preset';

import { ParseError, parseSubQuestions } from '../pipeline/parsers.js';
import { buildResearcherSystemPrompt, buildResearcherUserTurn } from '../prompts/researcher.js';
import type { SubQuestion } from '../types.js';

import { runHarnessLoop } from './run-loop.js';

export interface ResearcherInput {
  readonly runId: string;
  readonly question: string;
}

export interface ResearcherResult {
  readonly subQuestions: readonly SubQuestion[];
  readonly costUsd: number;
  readonly assistantMessage: string;
  readonly iterations: number;
}

export class ResearcherFailure extends Error {
  constructor(
    message: string,
    readonly cause: ParseError | Error,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'ResearcherFailure';
  }
}

export async function runResearcher(
  harness: SecureHarness,
  input: ResearcherInput,
): Promise<ResearcherResult> {
  const startCost = harness.costs.getTotalCost();
  const { assistantMessage, iterations } = await runHarnessLoop(harness, {
    system: buildResearcherSystemPrompt(),
    user: buildResearcherUserTurn(input.question),
    sessionId: `research-${input.runId}-researcher`,
  });

  let subQuestions: SubQuestion[];
  try {
    subQuestions = parseSubQuestions(assistantMessage);
  } catch (err) {
    if (err instanceof ParseError) {
      throw new ResearcherFailure(
        `Researcher produced invalid output: ${err.message}`,
        err,
        assistantMessage,
      );
    }
    throw err;
  }

  return {
    subQuestions,
    costUsd: harness.costs.getTotalCost() - startCost,
    assistantMessage,
    iterations,
  };
}
