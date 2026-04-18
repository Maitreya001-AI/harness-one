/**
 * Example: Self-Healing Guardrails with retry and backoff
 *
 * When a guardrail blocks output, self-healing retries with the LLM.
 * The blocked content + a retry prompt are fed back so the LLM can
 * produce a compliant response.
 */
import {
  createContentFilter,
  withSelfHealing,
} from 'harness-one/guardrails';

async function main() {
  // Create a content filter that blocks profanity
  const filter = createContentFilter({ blocked: ['badword', 'offensive'] });

  // Run a single piece of content through self-healing. `withSelfHealing`
  // accepts a flat config bag: the guardrail list, a retry-prompt builder,
  // and a regenerate() hook that re-queries the LLM.
  const initialContent = 'This is perfectly fine content.';

  const result = await withSelfHealing(
    {
      maxRetries: 3,
      guardrails: [{ name: filter.name, guard: filter.guard }],
      buildRetryPrompt: (_content, failures) =>
        `Rewrite the response, avoiding: ${failures[0]?.reason ?? 'unknown'}`,
      regenerate: async (prompt) => {
        // In production, call the LLM again with the retry prompt.
        console.log('Regenerating after guardrail block:', prompt);
        return 'Here is a clean response without any problematic content.';
      },
    },
    initialContent,
  );

  console.log(`Content: ${result.content}`);
  console.log(`Attempts: ${result.attempts}`);
  console.log(`Passed: ${result.passed}`);
  if (result.failureReason) {
    console.log(`Final failure reason: ${result.failureReason}`);
  }
}

main().catch(console.error);
