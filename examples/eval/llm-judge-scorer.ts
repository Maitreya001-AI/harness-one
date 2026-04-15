// Install: npm install @anthropic-ai/sdk
//
// This example shows how to implement harness-one's Scorer interface using
// LLM-as-Judge. An LLM evaluates the quality of agent outputs, returning
// a 0-1 score with an explanation.

import Anthropic from '@anthropic-ai/sdk';
import type { Scorer, EvalCase } from '@harness-one/devkit';

// ---------------------------------------------------------------------------
// LLM Judge Scorer
// ---------------------------------------------------------------------------

/**
 * Create a Scorer that uses an LLM to judge output quality.
 *
 * The judge is prompted with the input, output, and optional context,
 * then asked to rate quality on a 0-1 scale with reasoning.
 *
 * Usage:
 *   const judge = createLLMJudge({ apiKey: process.env.ANTHROPIC_API_KEY! });
 *   const { score, explanation } = await judge.score('What is 2+2?', '4', 'Math quiz');
 */
export function createLLMJudge(config: {
  apiKey?: string;
  model?: string;
  criteria?: string;
}): Scorer {
  const client = new Anthropic({ apiKey: config.apiKey });
  const model = config.model ?? 'claude-sonnet-4-20250514';
  const criteria =
    config.criteria ??
    'accuracy, completeness, clarity, and helpfulness';

  return {
    name: 'llm-judge',
    description: `LLM-based scorer evaluating: ${criteria}`,

    async score(
      input: string,
      output: string,
      context?: string,
    ): Promise<{ score: number; explanation: string }> {
      const systemPrompt = `You are an expert evaluator. You will assess the quality of an AI assistant's output.

Evaluate based on these criteria: ${criteria}

You MUST respond with valid JSON in exactly this format:
{"score": <number between 0.0 and 1.0>, "explanation": "<brief reasoning>"}

Scoring guide:
- 0.0: Completely wrong, harmful, or irrelevant
- 0.25: Mostly wrong with some relevant elements
- 0.5: Partially correct but incomplete or unclear
- 0.75: Good answer with minor issues
- 1.0: Excellent, fully correct and well-articulated`;

      const userPrompt = [
        '## Input',
        input,
        '',
        '## Output to evaluate',
        output,
        context ? `\n## Context\n${context}` : '',
        '',
        'Respond with JSON only.',
      ].join('\n');

      const response = await client.messages.create({
        model,
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      // Extract text from the response
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      // Parse the JSON response
      try {
        const parsed = JSON.parse(text) as { score: number; explanation: string };
        // Clamp score to 0-1
        const clampedScore = Math.max(0, Math.min(1, parsed.score));
        return { score: clampedScore, explanation: parsed.explanation };
      } catch {
        // If parsing fails, return a low score with the raw text as explanation
        return {
          score: 0,
          explanation: `Failed to parse judge response: ${text.slice(0, 200)}`,
        };
      }
    },
  };
}

/**
 * Create a specialized scorer for a specific dimension (e.g., factual accuracy).
 * This demonstrates composing multiple judges for multi-dimensional evaluation.
 */
export function createDimensionJudge(
  dimension: string,
  description: string,
  config: { apiKey?: string; model?: string },
): Scorer {
  return createLLMJudge({
    ...config,
    criteria: `${dimension}: ${description}`,
  });
}

// ---------------------------------------------------------------------------
// Example: wire into createEvalRunner
// ---------------------------------------------------------------------------

// Note: importing here for the demo — in real code you'd import at the top
import { createEvalRunner } from '@harness-one/devkit';

async function demo() {
  // Create multiple judge dimensions
  const relevanceJudge = createDimensionJudge(
    'relevance',
    'How relevant is the output to the input question?',
    { apiKey: process.env.ANTHROPIC_API_KEY },
  );

  const clarityJudge = createDimensionJudge(
    'clarity',
    'How clear and well-structured is the output?',
    { apiKey: process.env.ANTHROPIC_API_KEY },
  );

  // Wire judges into the eval runner
  const runner = createEvalRunner({
    scorers: [relevanceJudge, clarityJudge],
    passThreshold: 0.7,
    overallPassRate: 0.8,
  });

  // Define test cases
  const cases: EvalCase[] = [
    {
      id: 'case-1',
      input: 'What is the capital of France?',
      expectedOutput: 'Paris',
      context: 'Geography knowledge test',
    },
    {
      id: 'case-2',
      input: 'Explain quantum entanglement in simple terms',
      expectedOutput: 'A clear, accessible explanation of quantum entanglement',
      context: 'Science communication test',
    },
  ];

  // Run evaluation with a mock generator
  const report = await runner.run(cases, async (input) => {
    // In practice, this would call your agent
    return `The answer to "${input}" is: this is a test response.`;
  });

  console.log(`Pass rate: ${(report.passRate * 100).toFixed(0)}%`);
  console.log(`Average scores:`, report.averageScores);
  for (const result of report.results) {
    console.log(`  ${result.caseId}: ${result.passed ? 'PASS' : 'FAIL'}`, result.scores);
  }
}

demo().catch(console.error);
