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
    startedAt: Date.now() - 10000,
    endedAt: Date.now(),
    status: 'error',
    spans: [
      { id: 's1', name: 'tool:search', startedAt: Date.now() - 9000, endedAt: Date.now() - 8000, status: 'completed', attributes: {} },
      { id: 's2', name: 'tool:search', startedAt: Date.now() - 8000, endedAt: Date.now() - 7000, status: 'completed', attributes: {} },
      { id: 's3', name: 'tool:search', startedAt: Date.now() - 7000, endedAt: Date.now() - 6000, status: 'completed', attributes: {} },
      { id: 's4', name: 'tool:search', startedAt: Date.now() - 6000, endedAt: Date.now() - 5000, status: 'completed', attributes: {} },
      { id: 's5', name: 'tool:search', startedAt: Date.now() - 5000, endedAt: Date.now() - 4000, status: 'completed', attributes: {} },
    ],
    metadata: {},
  };

  // Classify the failure
  const classifications = taxonomy.classify(trace);

  for (const classification of classifications) {
    console.log(`Failure type: ${classification.type}`);
    console.log(`Confidence: ${(classification.confidence * 100).toFixed(0)}%`);
    console.log(`Evidence: ${classification.evidence}`);
    console.log();
  }

  // Example: early stop trace (agent stopped before completing)
  const earlyStopTrace: Trace = {
    id: 'trace-2',
    name: 'agent-run',
    startedAt: Date.now() - 2000,
    endedAt: Date.now(),
    status: 'completed',
    spans: [
      { id: 's1', name: 'llm:call', startedAt: Date.now() - 1500, endedAt: Date.now() - 500, status: 'completed', attributes: { outputTokens: 5 } },
    ],
    metadata: {},
  };

  const earlyStopResult = taxonomy.classify(earlyStopTrace);
  console.log('Early stop analysis:', earlyStopResult.length > 0 ? earlyStopResult : 'No failures detected');
}

main().catch(console.error);
