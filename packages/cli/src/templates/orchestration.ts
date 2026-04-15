/**
 * Template for the 'orchestration' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules orchestration`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import {
  createOrchestrator,
  createAgentPool,
  createHandoff,
  createContextBoundary,
  createRoundRobinStrategy,
  spawnSubAgent,
} from 'harness-one/orchestration';

// 1. Create an orchestrator with a round-robin delegation strategy
const orchestrator = createOrchestrator({
  strategy: createRoundRobinStrategy(),
  mode: 'cooperative',
});

// 2. Register agents
orchestrator.register('agent-a', 'Researcher', { metadata: { role: 'research' } });
orchestrator.register('agent-b', 'Writer', { metadata: { role: 'writing' } });

// 3. Delegate work: strategy picks one of the registered agents
const selected = await orchestrator.delegate({
  id: 'task-1',
  description: 'Summarize the latest findings',
  requiredCapabilities: ['research'],
});
console.log('Delegated to:', selected);

// 4. Pool short-lived sub-agents for bounded concurrency
const pool = createAgentPool({
  maxSize: 4,
  factory: async (id) => ({
    id,
    async run(input: string) {
      return \`Processed: \${input}\`;
    },
  }),
});

const agent = await pool.acquire();
try {
  const result = await agent.run('demo input');
  console.log(result);
} finally {
  await pool.release(agent);
}

// 5. Handoff payload between agents with verification receipts
const handoff = createHandoff();
const receipt = handoff.prepare({
  from: 'agent-a',
  to: 'agent-b',
  artifacts: [{ id: 'doc-1', type: 'document', content: 'Draft' }],
});
console.log('Handoff receipt:', receipt.id);

// 6. Enforce context boundary policies between agents
const boundary = createContextBoundary({
  policies: [
    { agentId: 'agent-b', allowRead: ['draft.'], allowWrite: ['final.'] },
  ],
});
const ctx = boundary.wrap('agent-b', {});
ctx.set('final.result', 'ok');

// 7. Spawn a short-lived subagent with its own boundary
const sub = await spawnSubAgent({
  id: 'sub-1',
  parentId: 'agent-a',
  async run() { return 'done'; },
});
console.log('Sub result:', sub.result);
`;
