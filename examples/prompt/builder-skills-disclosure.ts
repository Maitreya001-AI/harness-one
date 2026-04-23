/**
 * Example: the four independent `harness-one/prompt` primitives.
 *
 * Each primitive is standalone:
 *
 *   1. `createPromptBuilder`      — multi-layer assembly with KV-cache prefix
 *   2. `createPromptRegistry`     — versioned template storage
 *   3. `createSkillRegistry`      — stateless skill content registry
 *   4. `createDisclosureManager`  — progressive knowledge disclosure by level
 */
import {
  createPromptBuilder,
  createPromptRegistry,
  createSkillRegistry,
  createDisclosureManager,
} from 'harness-one/prompt';

function main(): void {
  const builder = createPromptBuilder({ separator: '\n\n', maxTokens: 2000 });
  builder.addLayer({
    name: 'system',
    content: 'You are a precise software architect.',
    priority: 0,
    cacheable: true,
  });
  builder.addLayer({
    name: 'style',
    content: 'Respond in bullet points. Cite file paths when applicable.',
    priority: 5,
    cacheable: true,
  });
  builder.addLayer({
    name: 'task',
    content: 'Current task: {{task}}',
    priority: 10,
    cacheable: false,
  });
  builder.setVariable('task', 'audit cache invalidation');

  const assembled = builder.build();
  console.log('systemPrompt:\n', assembled.systemPrompt);
  console.log('stablePrefixHash:', assembled.stablePrefixHash);

  const registry = createPromptRegistry();
  registry.register({
    id: 'code-review',
    version: '1.0.0',
    content: 'Review the following code for {{concern}}:\n\n{{snippet}}',
    variables: ['concern', 'snippet'],
  });
  const rendered = registry.resolve('code-review', {
    concern: 'memory leaks',
    snippet: 'function leak() { ... }',
  });
  console.log('Rendered template:\n', rendered);

  const skills = createSkillRegistry();
  skills.register({
    id: 'customer_support',
    description: 'Customer support workflow',
    content: `
1. Start with a short greeting.
2. Ask clarifying questions when the request is ambiguous.
3. Use \`lookup_order\` for order state and \`search_kb\` for policy answers.
4. Escalate to a human when the user asks for it or policy requires it.
`.trim(),
    requiredTools: ['lookup_order', 'search_kb', 'escalate_human'],
  });
  const skillPrompt = skills.render(['customer_support']);
  console.log('Skill prompt:\n', skillPrompt.content);
  console.log('Rendered skill hash:', skillPrompt.stableHash);

  const disclosure = createDisclosureManager();
  disclosure.register('auth', [
    { level: 0, content: 'Authentication uses JWT bearer tokens.' },
    { level: 1, content: 'Tokens expire after 1 hour; refresh via /auth/refresh.' },
    { level: 2, content: 'Refresh rotates the JWT. Old JWTs are invalidated server-side.' },
  ]);

  console.log('Level 0:', disclosure.getContent('auth', 0));
  console.log('After expand:', disclosure.expand('auth'));
  console.log('All registered topics:', disclosure.listTopics());
}

main();
