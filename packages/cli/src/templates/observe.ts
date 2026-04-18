/**
 * Template for the 'observe' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules observe`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import {
  createTraceManager,
  createConsoleExporter,
  createCostTracker,
} from 'harness-one/observe';

// 1. Set up tracing with console exporter
const exporter = createConsoleExporter({ verbose: false });
const tm = createTraceManager({ exporters: [exporter] });

// 2. Trace an agent request
const traceId = tm.startTrace('user-request', { userId: 'alice' });

const llmSpan = tm.startSpan(traceId, 'llm-call');
tm.setSpanAttributes(llmSpan, { model: 'claude-3', tokens: 1500 });
// ... your LLM call here ...
tm.endSpan(llmSpan);

const toolSpan = tm.startSpan(traceId, 'tool-execution');
tm.addSpanEvent(toolSpan, { name: 'tool-start', attributes: { tool: 'calculator' } });
// ... tool execution ...
tm.endSpan(toolSpan);

tm.endTrace(traceId);

// 3. Track costs with budget alerts
const costTracker = createCostTracker({
  pricing: [
    { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    { model: 'gpt-4', inputPer1kTokens: 0.03, outputPer1kTokens: 0.06 },
  ],
  budget: 10.0,
});

costTracker.onAlert((alert) => {
  console.warn(\`Cost alert [\${alert.type}]: \${alert.message}\`);
});

costTracker.recordUsage({
  traceId,
  model: 'claude-3',
  inputTokens: 1000,
  outputTokens: 500,
});

console.log('Total cost:', costTracker.getTotalCost().toFixed(4));
console.log('Cost by model:', Object.fromEntries(costTracker.getCostByModel()));
`;
