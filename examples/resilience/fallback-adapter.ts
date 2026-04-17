/**
 * Example: FallbackAdapter with circuit-breaker pattern
 *
 * Demonstrates automatic adapter failover when one provider experiences errors.
 * After 3 consecutive failures (configurable), the adapter switches to the next
 * in the list. The failure count resets on any successful call.
 */
import { AgentLoop } from 'harness-one/core';
import { createFallbackAdapter } from 'harness-one/advanced';
// import { createAnthropicAdapter } from '@harness-one/anthropic';
// import { createOpenAIAdapter } from '@harness-one/openai';

// In production, create real adapters:
// const primary = createAnthropicAdapter({ client, model: 'claude-sonnet-4-20250514' });
// const fallback = createOpenAIAdapter({ client, model: 'gpt-4o' });

// For this example, we use mock adapters to demonstrate the pattern:
const mockPrimary = {
  async chat() {
    throw new Error('rate limit exceeded (429)');
  },
};
const mockFallback = {
  async chat() {
    return {
      message: { role: 'assistant' as const, content: 'Response from fallback adapter' },
      usage: { inputTokens: 10, outputTokens: 20 },
    };
  },
};

async function main() {
  // Create a fallback adapter that switches after 2 consecutive failures
  const adapter = createFallbackAdapter({
    adapters: [mockPrimary, mockFallback],
    maxFailures: 2,
  });

  // The adapter will fail twice on the primary, then switch to the fallback
  const loop = new AgentLoop({ adapter, maxIterations: 1 });

  for await (const event of loop.run([{ role: 'user', content: 'Hello' }])) {
    if (event.type === 'message') {
      // After 2 failures on primary, this comes from the fallback adapter
      console.log('Response:', event.message.content);
    }
    if (event.type === 'error') {
      console.log('Error (will retry with fallback):', event.error.message);
    }
  }
}

main().catch(console.error);
