/**
 * Generator-Evaluator separation pattern.
 *
 * Generates output, evaluates it, and retries with feedback if evaluation fails.
 * Implements Anthropic's pattern: "separating evaluation is easier to tune than self-critique."
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type { GeneratorEvaluatorConfig } from './types.js';

/**
 * Run a Generator-Evaluator loop: generate output, evaluate it,
 * if evaluation fails, retry with feedback up to maxRetries.
 *
 * @example
 * ```ts
 * const result = await runGeneratorEvaluator({
 *   generate: async (input) => `Answer: ${input}`,
 *   evaluate: async (input, output) => ({ pass: output.length > 5, feedback: 'Too short' }),
 * }, 'What is AI?');
 * ```
 */
export async function runGeneratorEvaluator(
  config: GeneratorEvaluatorConfig,
  input: string,
): Promise<{
  output: string;
  attempts: number;
  passed: boolean;
  feedback?: string;
}> {
  const { generate, evaluate, maxRetries = 3 } = config;

  if (maxRetries < 1) {
    throw new HarnessError(
      'maxRetries must be at least 1',
      'EVAL_CONFIG',
      'Set maxRetries to 1 or higher',
    );
  }

  let lastOutput = '';
  let lastFeedback: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const augmentedInput = lastFeedback
      ? `${input}\n\nPrevious feedback: ${lastFeedback}`
      : input;

    lastOutput = await generate(augmentedInput);
    const evalResult = await evaluate(input, lastOutput);

    if (evalResult.pass) {
      return {
        output: lastOutput,
        attempts: attempt,
        passed: true,
      };
    }

    lastFeedback = evalResult.feedback;
  }

  return {
    output: lastOutput,
    attempts: maxRetries,
    passed: false,
    feedback: lastFeedback,
  };
}
