/**
 * Example: Self-Healing Guardrails with retry and backoff
 *
 * When a guardrail blocks output, self-healing retries with the LLM
 * using exponential backoff. The blocked content is fed back as context
 * so the LLM can produce a compliant response.
 */
import {
  createPipeline,
  createContentFilter,
  withSelfHealing,
  runOutput,
} from 'harness-one/guardrails';

async function main() {
  // Create a content filter that blocks profanity
  const filter = createContentFilter({ blocked: ['badword', 'offensive'] });

  // Create a pipeline with the content filter
  const pipeline = createPipeline({
    input: [],
    output: [{ name: filter.name, guard: filter.guard }],
  });

  // Wrap with self-healing: retries up to 3 times with exponential backoff
  const selfHealing = withSelfHealing(pipeline, {
    maxRetries: 3,
    backoffMs: 500,
    regenerate: async (feedback) => {
      // In production, call the LLM again with the feedback
      console.log('Regenerating after guardrail block:', feedback);
      // Return a cleaned-up response
      return 'Here is a clean response without any problematic content.';
    },
  });

  // Test with clean content (passes immediately)
  const cleanResult = await runOutput(selfHealing.pipeline, {
    content: 'This is perfectly fine content.',
  });
  console.log('Clean content:', cleanResult.passed ? 'PASSED' : 'BLOCKED');

  // In production, the self-healing would be used inside the agent loop
  // to automatically retry when guardrails block the LLM's output.
  console.log('\nSelf-healing config:');
  console.log(`  Max retries: ${selfHealing.maxRetries}`);
  console.log(`  Backoff: ${selfHealing.backoffMs}ms (exponential)`);
}

main().catch(console.error);
