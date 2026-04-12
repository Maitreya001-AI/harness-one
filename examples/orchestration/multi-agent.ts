/**
 * Example: Multi-Agent Orchestration
 *
 * Demonstrates the orchestration module with agent pools, handoff
 * protocols, and context boundaries for multi-agent workflows.
 */
import { AgentLoop, createMockAdapter } from 'harness-one/core';
import {
  createOrchestrator,
  createAgentPool,
  createHandoff,
  createContextBoundary,
} from 'harness-one/orchestration';

async function main() {
  // 1. Create an agent pool with factory
  const pool = createAgentPool({
    factory: (role) => new AgentLoop({
      adapter: createMockAdapter({
        responses: [
          { content: `[${role ?? 'agent'}] Task completed successfully.`, toolCalls: [] },
        ],
      }),
      maxIterations: 3,
    }),
    min: 1,
    max: 5,
    idleTimeout: 30_000,
  });

  console.log('Pool stats:', pool.stats);

  // 2. Acquire agents from the pool
  const researcher = pool.acquire('researcher');
  const writer = pool.acquire('writer');
  console.log(`Acquired: ${researcher.id} (${researcher.role}), ${writer.id} (${writer.role})`);

  // 3. Create a handoff protocol for structured task delegation
  const handoff = createHandoff();

  // Send a task from researcher to writer
  handoff.send({
    from: researcher.id,
    to: writer.id,
    payload: { task: 'Write a summary based on research findings' },
    priority: 1,
  });

  // Writer receives the task
  const received = handoff.receive(writer.id);
  if (received) {
    console.log(`Writer received task: ${JSON.stringify(received.payload)}`);
  }

  // 4. Create context boundaries for access control
  const sharedContext = createContextBoundary({
    data: {
      researchFindings: 'Key finding: AI adoption increased 40% in 2025',
      confidentialData: 'INTERNAL: Q4 revenue projections',
    },
    accessPolicy: {
      [researcher.id]: ['researchFindings', 'confidentialData'],
      [writer.id]: ['researchFindings'], // Writer cannot access confidential data
    },
  });

  console.log(`\nResearcher can access: ${sharedContext.accessibleKeys(researcher.id).join(', ')}`);
  console.log(`Writer can access: ${sharedContext.accessibleKeys(writer.id).join(', ')}`);

  // 5. Clean up
  pool.release(researcher);
  pool.release(writer);
  pool.dispose();
  console.log('\nPool disposed. Final stats:', pool.stats);
}

main().catch(console.error);
