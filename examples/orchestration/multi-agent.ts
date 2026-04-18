/**
 * Example: Multi-Agent Orchestration
 *
 * Shows how to compose:
 *   - `createAgentPool` (agent lifecycle + warm-up)
 *   - `createOrchestrator` (message transport + context store)
 *   - `createHandoff` (structured handoff protocol on top of the orchestrator)
 *   - `createContextBoundary` (advisory access control over SharedContext)
 *
 * All four primitives live on `harness-one/orchestration`.
 */
import { AgentLoop } from 'harness-one/core';
import { createMockAdapter } from 'harness-one/testing';
import {
  createOrchestrator,
  createAgentPool,
  createHandoff,
  createContextBoundary,
} from 'harness-one/orchestration';

async function main() {
  // 1. Agent pool — warm-up factory per role.
  const pool = createAgentPool({
    factory: (role) =>
      new AgentLoop({
        adapter: createMockAdapter({
          responses: [
            { content: `[${role ?? 'agent'}] Task completed successfully.` },
          ],
        }),
        maxIterations: 3,
      }),
    min: 1,
    max: 5,
    idleTimeout: 30_000,
  });
  console.log('Pool stats:', pool.stats);

  // 2. Acquire role-tagged agents from the pool.
  const researcher = pool.acquire('researcher');
  const writer = pool.acquire('writer');
  console.log(
    `Acquired: ${researcher.id} (${researcher.role}), ${writer.id} (${writer.role})`,
  );

  // 3. Orchestrator — central registry + message bus the handoff rides on.
  const orchestrator = createOrchestrator();
  orchestrator.register(researcher.id, 'researcher');
  orchestrator.register(writer.id, 'writer');

  const handoff = createHandoff(orchestrator);

  // Send a structured handoff from researcher to writer.
  handoff.send(researcher.id, writer.id, {
    summary: 'Write a summary based on research findings',
    artifacts: [
      { type: 'note', content: 'AI adoption increased 40% in 2025' },
    ],
    acceptanceCriteria: ['two-paragraph summary', 'cites the note above'],
    priority: 'high',
  });

  const received = handoff.receive(writer.id);
  if (received) {
    console.log(`Writer received handoff: ${received.summary}`);
  }

  // 4. Context boundary — layered over the orchestrator's SharedContext.
  orchestrator.context.set('researchFindings', 'AI adoption increased 40%');
  orchestrator.context.set('confidentialData', 'INTERNAL: Q4 revenue');

  const boundary = createContextBoundary(orchestrator.context, [
    {
      agent: researcher.id,
      allowRead: ['researchFindings', 'confidentialData'],
    },
    {
      agent: writer.id,
      // Writer sees the public key only — confidential prefix denied.
      allowRead: ['researchFindings'],
      denyRead: ['confidentialData'],
    },
  ]);

  const researcherView = boundary.forAgent(researcher.id);
  const writerView = boundary.forAgent(writer.id);
  console.log(
    `Researcher sees confidential data:`,
    researcherView.get('confidentialData'),
  );
  console.log(
    `Writer sees confidential data:`,
    writerView.get('confidentialData') ?? '<denied>',
  );

  // 5. Clean up.
  pool.release(researcher);
  pool.release(writer);
  await pool.dispose();
  orchestrator.dispose();
  console.log('\nPool disposed. Final stats:', pool.stats);
}

main().catch(console.error);
