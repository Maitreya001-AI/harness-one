/**
 * Example: `runGeneratorEvaluator` + `extractNewCases` (data flywheel).
 *
 * The Generator-Evaluator pattern separates "produce an answer" from "judge
 * the answer" — per Anthropic: separated evaluators are easier to tune than
 * self-critique. The data flywheel closes the loop: low-scoring runs are
 * auto-extracted as new test cases so regressions become a CI gate instead
 * of tribal memory.
 *
 * Pair with `createEvalRunner` (see `eval/llm-judge-scorer.ts`) for batch
 * CI-style evaluation.
 */
import {
  runGeneratorEvaluator,
  createEvalRunner,
  createBasicRelevanceScorer,
  createBasicLengthScorer,
  extractNewCases,
} from '@harness-one/devkit';
import type { EvalCase, EvalReport } from '@harness-one/devkit';

async function main(): Promise<void> {
  // ── 1. Generator-Evaluator loop ─────────────────────────────────────────
  // Each attempt: generate → evaluate → retry with feedback if it fails.
  const result = await runGeneratorEvaluator(
    {
      generate: async (input) => {
        // Real implementation: call an LLM with `input`. Here a toy generator
        // to show the control flow.
        if (input.includes('Previous feedback')) {
          return 'Harness engineering is the 30% of AI product work that makes the ' +
            'other 70% reliable: budgets, guardrails, evaluation, and retry logic.';
        }
        return 'Harness = hard stuff.'; // deliberately too short
      },
      evaluate: async (_input, output) => {
        const tooShort = output.length < 80;
        return {
          pass: !tooShort,
          feedback: tooShort ? 'Expand to at least 80 characters with concrete examples.' : '',
        };
      },
      maxRetries: 3,
    },
    'Define harness engineering in production-ready terms.',
  );
  console.log(`Attempts: ${result.attempts}, passed: ${result.passed}`);
  console.log('Final output:', result.output);

  // ── 2. Batch evaluation with multiple scorers ───────────────────────────
  const runner = createEvalRunner({
    scorers: [
      createBasicRelevanceScorer(),
      createBasicLengthScorer({ minTokens: 20, maxTokens: 150 }),
    ],
    passThreshold: 0.6,
    overallPassRate: 0.8,
  });

  const cases: EvalCase[] = [
    { id: 'c1', input: 'What is harness engineering?', expectedOutput: 'harness discipline' },
    { id: 'c2', input: 'Explain KV-cache stability.', expectedOutput: 'stable prefix' },
    { id: 'c3', input: 'When do guardrails fail closed?', expectedOutput: 'on error by default' },
  ];

  const report: EvalReport = await runner.run(cases, async (input) => {
    // Hook up a real adapter here. For the demo, return predictable text.
    return `Answer related to ${input.toLowerCase()}`;
  });

  console.log(`\nBatch: ${report.totalCases} cases, passRate=${report.passRate.toFixed(2)}`);
  console.log('Average scores:', report.averageScores);
  console.log('Gate passes:', runner.checkGate(report));

  // ── 3. Data flywheel — low-scoring runs become new regression tests ────
  // extractNewCases picks the worst N results, tags them, and gives each one
  // a collision-resistant id so you can merge them straight into your suite.
  const newCases = extractNewCases(report, {
    scoreThreshold: 0.5, // anything below this average is eligible
    maxNewCases: 5,
  });
  console.log(`\nFlywheel generated ${newCases.length} regression cases:`);
  for (const c of newCases) {
    console.log(`  ${c.id}  tags=${c.tags?.join(',')}`);
  }
  // Feed newCases into your next `runner.run([...existing, ...newCases], …)`
  // to lock in the regression.
}

main().catch(console.error);
