/**
 * Specialist agent — answers a single subquestion using web tools.
 *
 * The Specialist registers `web_search` and `web_fetch` on its harness, then
 * tracks every URL the model actually fetched. The parser uses this set to
 * reject any citation referencing a URL the agent never visited (the MVP
 * defence against citation fabrication called out in DESIGN §8 OQ7).
 */

import type { SecureHarness } from '@harness-one/preset';
import type { ToolDefinition } from 'harness-one/tools';

import {
  ParseError,
  parseSpecialistAnswer,
  type ParseSpecialistOptions,
} from '../pipeline/parsers.js';
import { buildSpecialistSystemPrompt, buildSpecialistUserTurn } from '../prompts/specialist.js';
import type { SpecialistAnswer, SubQuestion } from '../types.js';

import { runHarnessLoop } from './run-loop.js';

export interface SpecialistInput {
  readonly runId: string;
  readonly originalQuestion: string;
  readonly subQuestion: SubQuestion;
}

export interface SpecialistResult {
  readonly answer: SpecialistAnswer;
  readonly fetchedUrls: ReadonlySet<string>;
  readonly costUsd: number;
  readonly assistantMessage: string;
  readonly iterations: number;
}

export class SpecialistFailure extends Error {
  constructor(
    message: string,
    readonly subQuestionIndex: number,
    readonly cause: ParseError | Error,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'SpecialistFailure';
  }
}

export interface SpecialistTools {
  readonly webSearch: ToolDefinition<{ query: string; limit?: number }>;
  readonly webFetch: ToolDefinition<{ url: string }>;
}

/**
 * Register the Specialist's tools on the harness. Idempotent across a single
 * Specialist run — caller is responsible for handing in a fresh harness so
 * the registry isn't reused between runs.
 */
export function registerSpecialistTools(
  harness: SecureHarness,
  tools: SpecialistTools,
): void {
  harness.tools.register(tools.webSearch as unknown as Parameters<typeof harness.tools.register>[0]);
  harness.tools.register(tools.webFetch as unknown as Parameters<typeof harness.tools.register>[0]);
}

export async function runSpecialist(
  harness: SecureHarness,
  input: SpecialistInput,
): Promise<SpecialistResult> {
  const fetchedUrls = new Set<string>();
  const startCost = harness.costs.getTotalCost();

  const { assistantMessage, iterations } = await runHarnessLoop(harness, {
    system: buildSpecialistSystemPrompt(),
    user: buildSpecialistUserTurn(input.subQuestion, input.originalQuestion),
    sessionId: `research-${input.runId}-specialist-${input.subQuestion.index}`,
    onEvent: (event) => {
      if (event.type !== 'tool_call') return;
      if (event.toolCall.name !== 'web_fetch') return;
      const url = extractFetchUrl(event.toolCall.arguments);
      if (url !== undefined) fetchedUrls.add(url);
    },
  });

  let answer: SpecialistAnswer;
  try {
    const parseOpts: ParseSpecialistOptions = {
      subQuestionIndex: input.subQuestion.index,
      fetchedUrls,
    };
    answer = parseSpecialistAnswer(assistantMessage, parseOpts);
  } catch (err) {
    if (err instanceof ParseError) {
      throw new SpecialistFailure(
        `Specialist #${input.subQuestion.index} produced invalid output: ${err.message}`,
        input.subQuestion.index,
        err,
        assistantMessage,
      );
    }
    throw err;
  }

  return {
    answer,
    fetchedUrls,
    costUsd: harness.costs.getTotalCost() - startCost,
    assistantMessage,
    iterations,
  };
}

/**
 * Extract the `url` argument from a `web_fetch` tool call. Tool arguments are
 * supplied as an already-parsed object by the adapter (see
 * harness-one/tools `ToolCall.arguments` JSDoc), so we accept `{ url }`
 * directly. Returns `undefined` for malformed payloads — the harness already
 * surfaces validation errors, this helper just stays robust against edge
 * cases without polluting the URL set.
 */
function extractFetchUrl(args: string | Record<string, unknown>): string | undefined {
  let parsed: unknown = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const url = (parsed as Record<string, unknown>)['url'];
  if (typeof url !== 'string' || url.length === 0) return undefined;
  return url;
}
