/**
 * Template for the 'guardrails' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules guardrails`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import {
  createPipeline,
  createInjectionDetector,
  createContentFilter,
  createRateLimiter,
  runInput,
  runOutput,
  withSelfHealing,
} from 'harness-one/guardrails';

// 1. Create guardrails
const injection = createInjectionDetector({ sensitivity: 'medium' });
const filter = createContentFilter({ blocked: ['password', 'secret'] });
const limiter = createRateLimiter({ max: 10, windowMs: 60_000 });

// 2. Assemble pipeline (fail-closed by default)
const pipeline = createPipeline({
  input: [injection, filter, limiter],
  output: [filter],
  failClosed: true,
  onEvent: (event) => {
    console.log(\`[\${event.direction}] \${event.guardrail}: \${event.verdict.action} (\${event.latencyMs.toFixed(1)}ms)\`);
  },
});

// 3. Run guardrails on user input
const inputResult = await runInput(pipeline, { content: 'Hello, can you help me?' });
console.log('Input passed:', inputResult.passed);

// 4. Run guardrails on model output
const outputResult = await runOutput(pipeline, { content: 'Sure, here is your answer.' });
console.log('Output passed:', outputResult.passed);

// 5. Self-healing: auto-retry when guardrails block
const healed = await withSelfHealing({
  maxRetries: 3,
  guardrails: [filter],
  buildRetryPrompt: (content, failures) =>
    \`Rewrite without blocked content. Issues: \${failures.map(f => f.reason).join('; ')}\\nOriginal: \${content}\`,
  regenerate: async (prompt) => {
    // Replace with your LLM call
    return 'Here is a safe response.';
  },
}, 'Response containing password');
console.log('Healed:', healed.passed, 'Attempts:', healed.attempts);
`;
