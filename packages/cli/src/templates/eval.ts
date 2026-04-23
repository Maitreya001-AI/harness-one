/**
 * Template for the 'eval' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules eval`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import {
  createEvalRunner,
  createBasicRelevanceScorer,
  createBasicLengthScorer,
  createCustomScorer,
  runGeneratorEvaluator,
} from '@harness-one/devkit';

// 1. Set up scorers
const relevance = createBasicRelevanceScorer();
const length = createBasicLengthScorer({ minTokens: 5, maxTokens: 100 });
const politeness = createCustomScorer({
  name: 'politeness',
  description: 'Checks if output is polite',
  scoreFn: async (_input, output) => ({
    score: /please|thank|welcome/i.test(output) ? 1.0 : 0.5,
    explanation: 'Politeness keyword check',
  }),
});

// 2. Create eval runner with pass thresholds
const runner = createEvalRunner({
  scorers: [relevance, length, politeness],
  passThreshold: 0.6,
  overallPassRate: 0.8,
});

// 3. Define test cases
const cases = [
  { id: 'q1', input: 'What is TypeScript?', context: 'TypeScript is a typed language.' },
  { id: 'q2', input: 'Explain async await', context: 'Async/await handles asynchronous code.' },
];

// 4. Run evaluation
const report = await runner.run(cases, async (input) => {
  // Replace with your actual LLM call
  return \`Thank you for asking. \${input} is an important topic in programming.\`;
});

console.log('Pass rate:', (report.passRate * 100).toFixed(1) + '%');
console.log('Average scores:', report.averageScores);

// 5. Quality gate check
const gate = runner.checkGate(report);
console.log('Gate:', gate.passed ? 'PASS' : 'FAIL', gate.reason);

// 6. Generator-Evaluator loop
const result = await runGeneratorEvaluator({
  generate: async (input) => \`Answer about \${input}\`,
  evaluate: async (_input, output) => ({
    pass: output.length > 10,
    feedback: output.length <= 10 ? 'Response too short' : undefined,
  }),
  maxRetries: 3,
}, 'TypeScript generics');

console.log('Generator-Evaluator:', result.passed, 'attempts:', result.attempts);
`;
