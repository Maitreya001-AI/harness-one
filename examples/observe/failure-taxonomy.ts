/**
 * Example: Failure Taxonomy for post-mortem analysis
 *
 * Classifies agent failures into categories (tool loop, early stop,
 * budget exceeded, timeout, hallucination) from trace structure.
 */
import { createFailureTaxonomy } from 'harness-one/observe';
import type { Trace } from 'harness-one/observe';

async function main() {
  // Create a failure taxonomy with default detectors
  const taxonomy = createFailureTaxonomy();

  // Example trace that shows a tool loop (same tool called 5+ times)
  const trace: Trace = {
    id: 'trace-1',
    name: 'agent-run',
    startTime: Date.now() - 10000,
    endTime: Date.now(),
    status: 'error',
    userMetadata: {},
    systemMetadata: {},
    spans: [
      { id: 's1', traceId: 'trace-1', name: 'tool:search', startTime: Date.now() - 9000, endTime: Date.now() - 8000, status: 'completed', attributes: {}, events: [] },
      { id: 's2', traceId: 'trace-1', name: 'tool:search', startTime: Date.now() - 8000, endTime: Date.now() - 7000, status: 'completed', attributes: {}, events: [] },
      { id: 's3', traceId: 'trace-1', name: 'tool:search', startTime: Date.now() - 7000, endTime: Date.now() - 6000, status: 'completed', attributes: {}, events: [] },
      { id: 's4', traceId: 'trace-1', name: 'tool:search', startTime: Date.now() - 6000, endTime: Date.now() - 5000, status: 'completed', attributes: {}, events: [] },
      { id: 's5', traceId: 'trace-1', name: 'tool:search', startTime: Date.now() - 5000, endTime: Date.now() - 4000, status: 'completed', attributes: {}, events: [] },
    ],
  };

  // Classify the failure
  const classifications = taxonomy.classify(trace);

  for (const classification of classifications) {
    console.log(`Failure mode: ${classification.mode}`);
    console.log(`Confidence: ${(classification.confidence * 100).toFixed(0)}%`);
    console.log(`Evidence: ${classification.evidence}`);
    console.log();
  }

  // Example: early stop trace (agent stopped before completing)
  const earlyStopTrace: Trace = {
    id: 'trace-2',
    name: 'agent-run',
    startTime: Date.now() - 2000,
    endTime: Date.now(),
    status: 'completed',
    userMetadata: {},
    systemMetadata: {},
    spans: [
      { id: 's1', traceId: 'trace-2', name: 'llm:call', startTime: Date.now() - 1500, endTime: Date.now() - 500, status: 'completed', attributes: { outputTokens: 5 }, events: [] },
    ],
  };

  const earlyStopResult = taxonomy.classify(earlyStopTrace);
  console.log('Early stop analysis:', earlyStopResult.length > 0 ? earlyStopResult : 'No failures detected');
}

main().catch(console.error);
