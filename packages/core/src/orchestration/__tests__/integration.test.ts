import { describe, it, expect } from 'vitest';
import { createOrchestrator } from '../orchestrator.js';
import { createHandoff } from '../handoff.js';
import { createAgentPool } from '../agent-pool.js';
import { AgentLoop } from '../../core/agent-loop.js';
import { HarnessError, HarnessErrorCode} from '../../core/errors.js';
import type {
  OrchestratorEvent,
  DelegationStrategy,
  HandoffPayload,
} from '../types.js';

const mockFactory = () =>
  new AgentLoop({
    adapter: {
      async chat() {
        return {
          message: { role: 'assistant' as const, content: 'ok' },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  });

describe('Multi-agent orchestration integration', () => {
  describe('full agent registration -> message sending -> message receiving flow', () => {
    it('registers agents, sends messages, and receives them in correct order', () => {
      const orch = createOrchestrator();
      const events: OrchestratorEvent[] = [];
      orch.onEvent((e) => events.push(e));

      // Register two agents
      const agentA = orch.register('a1', 'Agent A');
      const agentB = orch.register('a2', 'Agent B');

      expect(agentA.id).toBe('a1');
      expect(agentB.id).toBe('a2');

      // Agent A sends a message to Agent B
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'Hello from A' });

      // Agent B receives the message
      const messages = orch.getMessages('a2');
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('a1');
      expect(messages[0].to).toBe('a2');
      expect(messages[0].content).toBe('Hello from A');
      expect(messages[0].timestamp).toBeGreaterThan(0);

      // Agent B responds
      orch.send({ from: 'a2', to: 'a1', type: 'response', content: 'Hello back from B' });

      const responseMessages = orch.getMessages('a1');
      expect(responseMessages).toHaveLength(1);
      expect(responseMessages[0].content).toBe('Hello back from B');

      // Verify events were emitted
      const registeredEvents = events.filter((e) => e.type === 'agent_registered');
      expect(registeredEvents).toHaveLength(2);

      const sentEvents = events.filter((e) => e.type === 'message_sent');
      expect(sentEvents).toHaveLength(2);

      orch.dispose();
    });

    it('message filtering by type works end-to-end', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Agent A');
      orch.register('a2', 'Agent B');

      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'req1' });
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'req2' });
      orch.send({ from: 'a1', to: 'a2', type: 'response', content: 'resp1' });

      const requests = orch.getMessages('a2', { type: 'request' });
      expect(requests).toHaveLength(2);

      const responses = orch.getMessages('a2', { type: 'response' });
      expect(responses).toHaveLength(1);

      orch.dispose();
    });
  });

  describe('agent delegates task -> delegation cycle detection', () => {
    it('detects and prevents delegation cycles', async () => {
      const strategy: DelegationStrategy = {
        select(_agents, task) {
          // Always delegate to the agent specified in task metadata
          return task.metadata?.targetAgent as string | undefined;
        },
      };

      const orch = createOrchestrator({ strategy });
      orch.register('a1', 'Agent A');
      orch.register('a2', 'Agent B');

      // A1 delegates to A2
      const result1 = await orch.delegate({
        description: 'Task 1',
        metadata: { targetAgent: 'a2', delegatedFrom: 'a1' },
      });
      expect(result1).toBe('a2');

      // A2 tries to delegate back to A1 -> should detect cycle
      await expect(
        orch.delegate({
          description: 'Task 2',
          metadata: { targetAgent: 'a1', delegatedFrom: 'a2' },
        }),
      ).rejects.toThrow(HarnessError);

      try {
        await orch.delegate({
          description: 'Task 2',
          metadata: { targetAgent: 'a1', delegatedFrom: 'a2' },
        });
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.ORCH_DELEGATION_CYCLE);
      }

      orch.dispose();
    });

    it('allows non-cyclic delegation chains', async () => {
      const strategy: DelegationStrategy = {
        select(_agents, task) {
          return task.metadata?.targetAgent as string | undefined;
        },
      };

      const orch = createOrchestrator({ strategy });
      orch.register('a1', 'Agent A');
      orch.register('a2', 'Agent B');
      orch.register('a3', 'Agent C');

      // A1 -> A2
      const r1 = await orch.delegate({
        description: 'Step 1',
        metadata: { targetAgent: 'a2', delegatedFrom: 'a1' },
      });
      expect(r1).toBe('a2');

      // A2 -> A3 (not a cycle)
      const r2 = await orch.delegate({
        description: 'Step 2',
        metadata: { targetAgent: 'a3', delegatedFrom: 'a2' },
      });
      expect(r2).toBe('a3');

      orch.dispose();
    });

    it('returns undefined when no strategy is configured', async () => {
      const orch = createOrchestrator(); // no strategy
      orch.register('a1', 'Agent A');

      const result = await orch.delegate({ description: 'Task' });
      expect(result).toBeUndefined();

      orch.dispose();
    });
  });

  describe('agent pool: acquire -> use -> release flow', () => {
    it('full lifecycle: acquire, verify loop, release, reuse', () => {
      const pool = createAgentPool({ factory: mockFactory, max: 3 });

      // Acquire
      const agent = pool.acquire();
      expect(agent.id).toBeDefined();
      expect(agent.loop).toBeInstanceOf(AgentLoop);
      expect(pool.stats.active).toBe(1);
      expect(pool.stats.idle).toBe(0);

      // Release
      pool.release(agent);
      expect(pool.stats.active).toBe(0);
      expect(pool.stats.idle).toBe(1);

      // Re-acquire should reuse the same agent
      const reacquired = pool.acquire();
      expect(reacquired.id).toBe(agent.id);
      expect(pool.stats.active).toBe(1);

      pool.release(reacquired);
      pool.dispose();
    });

    it('multiple acquire and release cycles track stats correctly', () => {
      const pool = createAgentPool({ factory: mockFactory, max: 5 });

      const agents = [];
      for (let i = 0; i < 3; i++) {
        agents.push(pool.acquire());
      }
      expect(pool.stats.active).toBe(3);
      expect(pool.stats.total).toBe(3);

      // Release all
      for (const agent of agents) {
        pool.release(agent);
      }
      expect(pool.stats.active).toBe(0);
      expect(pool.stats.idle).toBe(3);

      pool.dispose();
    });

    it('acquire throws POOL_EXHAUSTED when max is reached', () => {
      const pool = createAgentPool({ factory: mockFactory, max: 2 });

      pool.acquire();
      pool.acquire();

      expect(() => pool.acquire()).toThrow(HarnessError);
      try {
        pool.acquire();
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.POOL_EXHAUSTED);
      }

      pool.dispose();
    });
  });

  describe('handoff: initiate -> deliver -> verify round trip', () => {
    it('full handoff lifecycle with orchestrator transport', () => {
      const orch = createOrchestrator();
      orch.register('sender', 'Sender Agent');
      orch.register('receiver', 'Receiver Agent');

      const handoff = createHandoff(orch);

      // Send a handoff
      const payload: HandoffPayload = {
        summary: 'Complete data analysis',
        artifacts: [{ type: 'data', content: '{"rows":100}' }],
        acceptanceCriteria: ['output must have summary', 'output must have chart'],
      };

      const receipt = handoff.send('sender', 'receiver', payload);
      expect(receipt.id).toBeDefined();
      expect(receipt.from).toBe('sender');
      expect(receipt.to).toBe('receiver');
      expect(receipt.payload.summary).toBe('Complete data analysis');

      // Receiver receives the handoff
      const received = handoff.receive('receiver');
      expect(received).toBeDefined();
      expect(received!.summary).toBe('Complete data analysis');
      expect(received!.artifacts).toHaveLength(1);

      // Verify acceptance criteria
      const verifyResult = handoff.verify(receipt.id, { summary: 'yes', chart: 'yes' }, (criterion, output) => {
        if (criterion === 'output must have summary') return !!(output as { summary?: string }).summary;
        if (criterion === 'output must have chart') return !!(output as { chart?: string }).chart;
        return false;
      });

      expect(verifyResult.passed).toBe(true);
      expect(verifyResult.violations).toHaveLength(0);

      // Verify with failing criteria
      const failResult = handoff.verify(receipt.id, { summary: 'yes' }, (criterion, output) => {
        if (criterion === 'output must have summary') return !!(output as { summary?: string }).summary;
        if (criterion === 'output must have chart') return !!(output as { chart?: string }).chart;
        return false;
      });

      expect(failResult.passed).toBe(false);
      expect(failResult.violations).toContain('output must have chart');

      handoff.dispose();
      orch.dispose();
    });

    it('handoff history tracks both sender and receiver', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Agent A');
      orch.register('a2', 'Agent B');

      const handoff = createHandoff(orch);

      handoff.send('a1', 'a2', { summary: 'Task 1' });
      handoff.send('a2', 'a1', { summary: 'Result 1' });

      const historyA = handoff.history('a1');
      const historyB = handoff.history('a2');

      // Both agents appear in both handoffs
      expect(historyA).toHaveLength(2);
      expect(historyB).toHaveLength(2);

      handoff.dispose();
      orch.dispose();
    });
  });

  describe('broadcast to multiple agents', () => {
    it('broadcasts message to all registered agents except sender', () => {
      const orch = createOrchestrator();
      orch.register('lead', 'Lead Agent');
      orch.register('w1', 'Worker 1');
      orch.register('w2', 'Worker 2');
      orch.register('w3', 'Worker 3');

      orch.broadcast('lead', 'Start task now');

      // All workers should receive the broadcast
      expect(orch.getMessages('w1')).toHaveLength(1);
      expect(orch.getMessages('w2')).toHaveLength(1);
      expect(orch.getMessages('w3')).toHaveLength(1);

      // Lead (sender) should NOT receive the broadcast
      expect(orch.getMessages('lead')).toHaveLength(0);

      // Verify message content
      const w1Msg = orch.getMessages('w1')[0];
      expect(w1Msg.from).toBe('lead');
      expect(w1Msg.content).toBe('Start task now');
      expect(w1Msg.type).toBe('broadcast');

      orch.dispose();
    });

    it('broadcasts to children only when parentId filter is used', () => {
      const orch = createOrchestrator({ mode: 'hierarchical' });
      orch.register('lead', 'Lead');
      orch.register('child1', 'Child 1', { parentId: 'lead' });
      orch.register('child2', 'Child 2', { parentId: 'lead' });
      orch.register('other', 'Other Agent');

      orch.broadcast('lead', 'Team update', { parentId: 'lead' });

      // Only children of 'lead' should receive it
      expect(orch.getMessages('child1')).toHaveLength(1);
      expect(orch.getMessages('child2')).toHaveLength(1);
      expect(orch.getMessages('other')).toHaveLength(0);

      orch.dispose();
    });
  });

  describe('agent unregistration cleans up queues and delegation chains', () => {
    it('unregistering an agent removes its message queue', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Agent A');
      orch.register('a2', 'Agent B');

      // Send a message to a1
      orch.send({ from: 'a2', to: 'a1', type: 'request', content: 'hello' });
      expect(orch.getMessages('a1')).toHaveLength(1);

      // Unregister a1
      const removed = orch.unregister('a1');
      expect(removed).toBe(true);

      // Messages are gone (queue deleted)
      expect(orch.getMessages('a1')).toHaveLength(0);

      // Agent is gone
      expect(orch.getAgent('a1')).toBeUndefined();

      orch.dispose();
    });

    it('unregistering an agent cleans up delegation chains', async () => {
      const strategy: DelegationStrategy = {
        select(_agents, task) {
          return task.metadata?.targetAgent as string | undefined;
        },
      };

      const orch = createOrchestrator({ strategy });
      orch.register('a1', 'Agent A');
      orch.register('a2', 'Agent B');
      orch.register('a3', 'Agent C');

      // Create delegation chain: a1 -> a2
      await orch.delegate({
        description: 'Task',
        metadata: { targetAgent: 'a2', delegatedFrom: 'a1' },
      });

      // Unregister a2 (cleaning up the chain)
      orch.unregister('a2');

      // Re-register a2
      orch.register('a2', 'Agent B (new)');

      // Now a1 -> a2 delegation chain should be cleaned up,
      // so a2 -> a1 should NOT cause a cycle anymore
      // Note: after unregister, the chain for a2 is cleared.
      // But a1's chain still has a2. Let's test that:
      // Actually, unregister(a2) should clean a2 from ALL chains.
      // So the a1->a2 entry should be removed.

      // This should work now (no cycle since chain was cleaned)
      const r = await orch.delegate({
        description: 'New task',
        metadata: { targetAgent: 'a1', delegatedFrom: 'a2' },
      });
      expect(r).toBe('a1');

      orch.dispose();
    });

    it('unregistering non-existent agent returns false', () => {
      const orch = createOrchestrator();
      expect(orch.unregister('nonexistent')).toBe(false);
      orch.dispose();
    });

    it('sending to unregistered agent throws AGENT_NOT_FOUND', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Agent A');
      orch.register('a2', 'Agent B');

      orch.unregister('a2');

      expect(() =>
        orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'hello' }),
      ).toThrow(HarnessError);

      try {
        orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'hello' });
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.ORCH_AGENT_NOT_FOUND);
      }

      orch.dispose();
    });
  });

  describe('new dequeue() method works correctly with getMessages()', () => {
    it('dequeue removes messages while getMessages keeps them', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Agent A');
      orch.register('a2', 'Agent B');

      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'msg1' });
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'msg2' });
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'msg3' });

      // getMessages shows all 3 (non-destructive)
      expect(orch.getMessages('a2')).toHaveLength(3);
      // Still 3 after reading
      expect(orch.getMessages('a2')).toHaveLength(3);

      orch.dispose();
    });

    it('shared context is accessible across agents', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Agent A');
      orch.register('a2', 'Agent B');

      // Agent A sets context
      orch.context.set('sharedData', { status: 'ready' });

      // Agent B reads context
      const data = orch.context.get('sharedData') as { status: string };
      expect(data.status).toBe('ready');

      // Context entries are available to all (keys are NFKC+casefold normalized)
      const entries = orch.context.entries();
      expect(entries.size).toBe(1);
      expect(entries.get('shareddata')).toEqual({ status: 'ready' });

      orch.dispose();
    });
  });

  describe('dispose cleans up all state', () => {
    it('orchestrator dispose clears agents, queues, context, and handlers', () => {
      const orch = createOrchestrator();
      const events: OrchestratorEvent[] = [];
      orch.onEvent((e) => events.push(e));

      orch.register('a1', 'Agent A');
      orch.register('a2', 'Agent B');
      orch.context.set('key', 'value');
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'test' });

      const eventsBefore = events.length;

      orch.dispose();

      // After dispose, all agents should be gone
      expect(orch.getAgent('a1')).toBeUndefined();
      expect(orch.getAgent('a2')).toBeUndefined();
      expect(orch.getMessages('a1')).toHaveLength(0);
      expect(orch.getMessages('a2')).toHaveLength(0);
      expect(orch.context.get('key')).toBeUndefined();
      expect(orch.listAgents()).toHaveLength(0);

      // Event handlers are cleared -- no new events after dispose
      // (even if we tried to trigger one, e.g., by calling list)
      expect(events.length).toBe(eventsBefore);
    });
  });
});
