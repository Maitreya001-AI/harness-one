/**
 * Template for the 'prompt' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules prompt`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import { createPromptBuilder, createPromptRegistry } from 'harness-one/prompt';

// 1. Build multi-layer prompts with KV-cache optimization
const builder = createPromptBuilder({ separator: '\\n\\n' });

builder.addLayer({
  name: 'system',
  content: 'You are an expert coding assistant.',
  priority: 0,
  cacheable: true, // Stable prefix for KV-cache hits
});

builder.addLayer({
  name: 'tools',
  content: 'Available tools: readFile, writeFile, search',
  priority: 1,
  cacheable: true,
});

builder.addLayer({
  name: 'user-context',
  content: 'The user is working on project: {{project}}',
  priority: 10,
  cacheable: false, // Dynamic content
});

builder.setVariable('project', 'harness-one');

const result = builder.build();
console.log('System prompt:', result.systemPrompt);
console.log('Cache hash:', result.stablePrefixHash);

// 2. Template registry with versioning
const registry = createPromptRegistry();

registry.register({
  id: 'greeting',
  version: '1.0',
  content: 'Hello {{name}}, welcome to {{project}}!',
  variables: ['name', 'project'],
});

const greeting = registry.resolve('greeting', { name: 'Alice', project: 'harness-one' });
console.log(greeting);
`;
