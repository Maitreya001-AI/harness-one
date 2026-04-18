/**
 * Example: the four independent `harness-one/prompt` primitives.
 *
 * Each primitive is standalone — use one without importing the others:
 *
 *   1. `createPromptBuilder`      — multi-layer assembly with KV-cache prefix
 *   2. `createPromptRegistry`     — versioned template storage
 *   3. `createSkillEngine`        — multi-stage guided workflows (state machine)
 *   4. `createDisclosureManager`  — progressive knowledge disclosure by level
 *
 * The Langfuse async-registry example (`prompt/langfuse-prompt-backend.ts`)
 * shows how to plug (2) into a remote template store; this file is the
 * local-first quickstart for all four.
 */
import {
  createPromptBuilder,
  createPromptRegistry,
  createSkillEngine,
  createDisclosureManager,
} from 'harness-one/prompt';

function main(): void {
  // ── 1. PromptBuilder — cacheable prefix + per-turn variables ────────────
  const builder = createPromptBuilder({ separator: '\n\n', maxTokens: 2000 });
  builder.addLayer({
    name: 'system',
    content: 'You are a precise software architect.',
    priority: 0,
    cacheable: true, // goes into the stable prefix (KV-cache friendly)
  });
  builder.addLayer({
    name: 'style',
    content: 'Respond in bullet points. Cite file paths with file:line when applicable.',
    priority: 5,
    cacheable: true,
  });
  builder.addLayer({
    name: 'task',
    content: 'Current task: {{task}}',
    priority: 10,
    cacheable: false, // varies per turn — NOT in the stable prefix
  });
  builder.setVariable('task', 'audit cache invalidation');

  const assembled = builder.build();
  console.log('systemPrompt:\n', assembled.systemPrompt);
  console.log('stablePrefixHash:', assembled.stablePrefixHash);
  // Feed assembled.systemPrompt into the first `{role:'system', content:...}`
  // message on the AgentLoop.

  // ── 2. PromptRegistry — versioned template store ────────────────────────
  const registry = createPromptRegistry();
  registry.register({
    id: 'code-review',
    version: '1.0.0', // semver-validated at register time
    content: 'Review the following code for {{concern}}:\n\n{{snippet}}',
    variables: ['concern', 'snippet'],
  });
  // `resolve()` interpolates and returns the final string; missing vars throw.
  const rendered = registry.resolve('code-review', {
    concern: 'memory leaks',
    snippet: 'function leak() { ... }',
  });
  console.log('Rendered template:\n', rendered);

  // ── 3. SkillEngine — multi-stage state machine ──────────────────────────
  const skills = createSkillEngine();
  skills.registerSkill({
    id: 'onboarding',
    name: 'User onboarding',
    description: 'Greet, clarify goals, execute.',
    initialStage: 'greet',
    stages: [
      {
        id: 'greet',
        name: 'Greeting',
        prompt: 'Greet the user and ask their goal.',
        tools: [], // allowed tools at this stage
        transitions: [
          { to: 'clarify', condition: { type: 'keyword', keywords: ['goal', 'want', 'need'] } },
        ],
      },
      {
        id: 'clarify',
        name: 'Clarification',
        prompt: 'Ask 2–3 clarifying questions.',
        tools: ['search_docs'],
        maxTurns: 3,
        transitions: [
          { to: 'execute', condition: { type: 'turn_count', count: 3 } },
        ],
      },
      {
        id: 'execute',
        name: 'Execution',
        prompt: 'Execute the task using available tools.',
        tools: ['search_docs', 'run_command'],
        transitions: [{ to: 'greet', condition: { type: 'manual' } }],
      },
    ],
  });
  skills.startSkill('onboarding');
  console.log('Initial prompt:', skills.getCurrentPrompt());
  console.log('Tools at stage:', skills.getAvailableTools());

  // Each turn: feed user text; engine checks transitions in order.
  const transition = skills.processTurn('I want to learn about RAG pipelines');
  if (transition.advanced) {
    console.log(`Advanced: ${transition.previousStage} → ${transition.currentStage}`);
  }

  // Manual advance:
  skills.advanceTo('execute');
  console.log('After manual advance, stage:', skills.currentStage.id);

  // ── 4. DisclosureManager — progressive knowledge loading ────────────────
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
