/**
 * Template for the 'core' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules core`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import { AgentLoop } from 'harness-one/core';
import type { AgentAdapter, Message } from 'harness-one/core';

// 1. Create an adapter for your LLM provider
const adapter: AgentAdapter = {
  async chat({ messages }) {
    // Replace with your actual LLM call (OpenAI, Anthropic, etc.)
    const lastMessage = messages[messages.length - 1];
    return {
      message: { role: 'assistant', content: \`Echo: \${lastMessage.content}\` },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  },
};

// 2. Create the agent loop with safety valves
const loop = new AgentLoop({
  adapter,
  maxIterations: 10,
  maxTotalTokens: 100_000,
  onToolCall: async (call) => {
    // Route tool calls to your tool registry
    return { result: \`Executed \${call.name}\` };
  },
});

// 3. Run the loop
const messages: Message[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello!' },
];

for await (const event of loop.run(messages)) {
  if (event.type === 'message') console.log('Assistant:', event.message.content);
  if (event.type === 'tool_call') console.log('Tool call:', event.toolCall.name);
  if (event.type === 'done') console.log('Done:', event.reason);
}
`;
