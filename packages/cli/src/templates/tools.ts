/**
 * Template for the 'tools' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules tools`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import { defineTool, createRegistry, toolSuccess, toolError } from 'harness-one/tools';

// 1. Define tools with JSON Schema validation
const calculator = defineTool<{ a: number; b: number; op: string }>({
  name: 'calculator',
  description: 'Perform basic arithmetic',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'number', description: 'First operand' },
      b: { type: 'number', description: 'Second operand' },
      op: { type: 'string', enum: ['add', 'sub', 'mul', 'div'], description: 'Operation' },
    },
    required: ['a', 'b', 'op'],
  },
  execute: async ({ a, b, op }) => {
    switch (op) {
      case 'add': return toolSuccess(a + b);
      case 'sub': return toolSuccess(a - b);
      case 'mul': return toolSuccess(a * b);
      case 'div': return b !== 0 ? toolSuccess(a / b) : toolError('Division by zero', 'validation');
      default: return toolError(\`Unknown op: \${op}\`, 'validation');
    }
  },
});

// 2. Create a registry with rate limiting
const registry = createRegistry({ maxCallsPerTurn: 5 });
registry.register(calculator);

// 3. Execute tool calls (validates input automatically)
const result = await registry.execute({
  id: 'call-1',
  name: 'calculator',
  arguments: JSON.stringify({ a: 10, b: 3, op: 'add' }),
});
console.log('Result:', result);

// 4. Wire to AgentLoop via handler()
const handler = registry.handler();
// Pass \`handler\` as onToolCall to AgentLoop
`;
