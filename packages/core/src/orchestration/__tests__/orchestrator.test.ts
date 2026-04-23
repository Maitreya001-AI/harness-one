import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOrchestrator } from '../orchestrator.js';
import {
  createBasicRoundRobinStrategy,
  createBasicRandomStrategy,
  createBasicFirstAvailableStrategy,
} from '../strategies.js';
import { HarnessError, HarnessErrorCode} from '../../core/errors.js';
import type { OrchestratorEvent, DelegationStrategy, AgentRegistration, DelegationTask } from '../types.js';

describe('createOrchestrator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('register', () => {
    it('registers an agent with default status idle', () => {
      const orch = createOrchestrator();
      const agent = orch.register('a1', 'Worker');
      expect(agent.id).toBe('a1');
      expect(agent.name).toBe('Worker');
      expect(agent.status).toBe('idle');
      expect(agent.parentId).toBeUndefined();
      expect(agent.metadata).toBeUndefined();
    });

    it('registers an agent with metadata', () => {
      const orch = createOrchestrator();
      const agent = orch.register('a1', 'Worker', { metadata: { role: 'coder' } });
      expect(agent.metadata).toEqual({ role: 'coder' });
    });

    it('registers an agent with parentId', () => {
      const orch = createOrchestrator({ mode: 'hierarchical' });
      orch.register('parent', 'Lead');
      const child = orch.register('child', 'Worker', { parentId: 'parent' });
      expect(child.parentId).toBe('parent');
    });

    it('throws on duplicate agent ID', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker');
      expect(() => orch.register('a1', 'Another')).toThrow(HarnessError);
      try {
        orch.register('a1', 'Another');
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.ORCH_DUPLICATE_AGENT);
      }
    });

    it('throws when maxAgents is reached', () => {
      const orch = createOrchestrator({ maxAgents: 2 });
      orch.register('a1', 'Worker1');
      orch.register('a2', 'Worker2');
      expect(() => orch.register('a3', 'Worker3')).toThrow(HarnessError);
      try {
        orch.register('a3', 'Worker3');
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.ORCH_MAX_AGENTS);
      }
    });

    it('throws when parentId references an unknown agent', () => {
      const orch = createOrchestrator();
      expect(() => orch.register('child', 'Worker', { parentId: 'nonexistent' })).toThrow(HarnessError);
      try {
        orch.register('child', 'Worker', { parentId: 'nonexistent' });
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.ORCH_AGENT_NOT_FOUND);
      }
    });

    it('emits agent_registered event', () => {
      const events: OrchestratorEvent[] = [];
      const orch = createOrchestrator();
      orch.onEvent((e) => events.push(e));
      orch.register('a1', 'Worker');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('agent_registered');
      if (events[0].type === 'agent_registered') {
        expect(events[0].agent.id).toBe('a1');
      }
    });
  });

  describe('unregister', () => {
    it('removes a registered agent', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker');
      const result = orch.unregister('a1');
      expect(result).toBe(true);
      expect(orch.getAgent('a1')).toBeUndefined();
    });

    it('returns false for unknown agent', () => {
      const orch = createOrchestrator();
      expect(orch.unregister('nope')).toBe(false);
    });

    it('clears message queue on unregister', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'hi' });
      orch.unregister('a2');
      // Re-register and check queue is empty
      orch.register('a2', 'Receiver2');
      expect(orch.getMessages('a2')).toHaveLength(0);
    });
  });

  describe('getAgent', () => {
    it('returns agent registration by ID', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker');
      const agent = orch.getAgent('a1');
      expect(agent).toBeDefined();
      expect(agent!.id).toBe('a1');
      expect(agent!.name).toBe('Worker');
    });

    it('returns undefined for unknown ID', () => {
      const orch = createOrchestrator();
      expect(orch.getAgent('nope')).toBeUndefined();
    });

    it('returns a snapshot (not a live reference)', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker');
      const snap1 = orch.getAgent('a1');
      orch.setStatus('a1', 'running');
      const snap2 = orch.getAgent('a1');
      expect(snap1!.status).toBe('idle');
      expect(snap2!.status).toBe('running');
    });
  });

  describe('listAgents', () => {
    it('lists all agents when no filter is given', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker1');
      orch.register('a2', 'Worker2');
      expect(orch.listAgents()).toHaveLength(2);
    });

    it('filters by status', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker1');
      orch.register('a2', 'Worker2');
      orch.setStatus('a1', 'running');
      const idle = orch.listAgents({ status: 'idle' });
      expect(idle).toHaveLength(1);
      expect(idle[0].id).toBe('a2');
    });

    it('filters by parentId', () => {
      const orch = createOrchestrator({ mode: 'hierarchical' });
      orch.register('lead', 'Lead');
      orch.register('w1', 'Worker1', { parentId: 'lead' });
      orch.register('w2', 'Worker2', { parentId: 'lead' });
      orch.register('w3', 'Worker3');
      const children = orch.listAgents({ parentId: 'lead' });
      expect(children).toHaveLength(2);
    });

    it('filters by both status and parentId', () => {
      const orch = createOrchestrator({ mode: 'hierarchical' });
      orch.register('lead', 'Lead');
      orch.register('w1', 'Worker1', { parentId: 'lead' });
      orch.register('w2', 'Worker2', { parentId: 'lead' });
      orch.setStatus('w1', 'running');
      const idleChildren = orch.listAgents({ status: 'idle', parentId: 'lead' });
      expect(idleChildren).toHaveLength(1);
      expect(idleChildren[0].id).toBe('w2');
    });

    it('returns empty array when no agents match', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker1');
      expect(orch.listAgents({ status: 'failed' })).toHaveLength(0);
    });
  });

  describe('setStatus', () => {
    it('updates agent status', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker');
      orch.setStatus('a1', 'running');
      expect(orch.getAgent('a1')!.status).toBe('running');
    });

    it('throws for unknown agent', () => {
      const orch = createOrchestrator();
      expect(() => orch.setStatus('nope', 'running')).toThrow(HarnessError);
      try {
        orch.setStatus('nope', 'running');
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.ORCH_AGENT_NOT_FOUND);
      }
    });

    it('emits agent_status_changed event', () => {
      const events: OrchestratorEvent[] = [];
      const orch = createOrchestrator();
      orch.register('a1', 'Worker');
      orch.onEvent((e) => events.push(e));
      orch.setStatus('a1', 'running');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('agent_status_changed');
      if (events[0].type === 'agent_status_changed') {
        expect(events[0].agentId).toBe('a1');
        expect(events[0].from).toBe('idle');
        expect(events[0].to).toBe('running');
      }
    });

    it('supports full status lifecycle idle -> running -> completed', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker');
      orch.setStatus('a1', 'running');
      expect(orch.getAgent('a1')!.status).toBe('running');
      orch.setStatus('a1', 'completed');
      expect(orch.getAgent('a1')!.status).toBe('completed');
    });

    it('supports failed status', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker');
      orch.setStatus('a1', 'running');
      orch.setStatus('a1', 'failed');
      expect(orch.getAgent('a1')!.status).toBe('failed');
    });
  });

  describe('send', () => {
    it('sends a message between agents', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'hello' });
      const messages = orch.getMessages('a2');
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('a1');
      expect(messages[0].to).toBe('a2');
      expect(messages[0].content).toBe('hello');
      expect(messages[0].type).toBe('request');
      expect(messages[0].timestamp).toBeGreaterThan(0);
    });

    it('sends a message with metadata', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'hello', metadata: { priority: 'high' } });
      const messages = orch.getMessages('a2');
      expect(messages[0].metadata).toEqual({ priority: 'high' });
    });

    it('throws when sender is unknown', () => {
      const orch = createOrchestrator();
      orch.register('a2', 'Receiver');
      expect(() => orch.send({ from: 'nope', to: 'a2', type: 'request', content: 'hi' })).toThrow(HarnessError);
      try {
        orch.send({ from: 'nope', to: 'a2', type: 'request', content: 'hi' });
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.ORCH_AGENT_NOT_FOUND);
      }
    });

    it('throws when receiver is unknown', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Sender');
      expect(() => orch.send({ from: 'a1', to: 'nope', type: 'request', content: 'hi' })).toThrow(HarnessError);
      try {
        orch.send({ from: 'a1', to: 'nope', type: 'request', content: 'hi' });
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.ORCH_AGENT_NOT_FOUND);
      }
    });

    it('emits message_sent event', () => {
      const events: OrchestratorEvent[] = [];
      const orch = createOrchestrator();
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');
      orch.onEvent((e) => events.push(e));
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'hello' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message_sent');
      if (events[0].type === 'message_sent') {
        expect(events[0].message.from).toBe('a1');
        expect(events[0].message.to).toBe('a2');
      }
    });
  });

  describe('getMessages', () => {
    it('returns empty array for agent with no messages', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker');
      expect(orch.getMessages('a1')).toHaveLength(0);
    });

    it('returns empty array for unknown agent', () => {
      const orch = createOrchestrator();
      expect(orch.getMessages('nope')).toHaveLength(0);
    });

    it('filters messages by type', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'req' });
      orch.send({ from: 'a1', to: 'a2', type: 'response', content: 'res' });
      const requests = orch.getMessages('a2', { type: 'request' });
      expect(requests).toHaveLength(1);
      expect(requests[0].content).toBe('req');
    });

    it('filters messages by since timestamp', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');

      vi.spyOn(Date, 'now').mockReturnValue(1000);
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'old' });

      vi.spyOn(Date, 'now').mockReturnValue(2000);
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'new' });

      const recent = orch.getMessages('a2', { since: 1500 });
      expect(recent).toHaveLength(1);
      expect(recent[0].content).toBe('new');
    });

    it('filters by both type and since', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');

      vi.spyOn(Date, 'now').mockReturnValue(1000);
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'old-req' });

      vi.spyOn(Date, 'now').mockReturnValue(2000);
      orch.send({ from: 'a1', to: 'a2', type: 'response', content: 'new-res' });
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'new-req' });

      const result = orch.getMessages('a2', { type: 'request', since: 1500 });
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('new-req');
    });
  });

  describe('broadcast', () => {
    it('sends to all agents except sender', () => {
      const orch = createOrchestrator();
      orch.register('lead', 'Lead');
      orch.register('w1', 'Worker1');
      orch.register('w2', 'Worker2');
      orch.broadcast('lead', 'attention');
      expect(orch.getMessages('w1')).toHaveLength(1);
      expect(orch.getMessages('w2')).toHaveLength(1);
      expect(orch.getMessages('lead')).toHaveLength(0);
    });

    it('broadcasts with type broadcast', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');
      orch.broadcast('a1', 'hello');
      const messages = orch.getMessages('a2');
      expect(messages[0].type).toBe('broadcast');
    });

    it('broadcasts with metadata', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');
      orch.broadcast('a1', 'hello', { metadata: { urgent: true } });
      const messages = orch.getMessages('a2');
      expect(messages[0].metadata).toEqual({ urgent: true });
    });

    it('broadcasts only to children of parentId', () => {
      const orch = createOrchestrator({ mode: 'hierarchical' });
      orch.register('lead', 'Lead');
      orch.register('w1', 'Worker1', { parentId: 'lead' });
      orch.register('w2', 'Worker2', { parentId: 'lead' });
      orch.register('w3', 'Worker3'); // No parent
      orch.broadcast('lead', 'team update', { parentId: 'lead' });
      expect(orch.getMessages('w1')).toHaveLength(1);
      expect(orch.getMessages('w2')).toHaveLength(1);
      expect(orch.getMessages('w3')).toHaveLength(0);
    });

    it('throws when sender is unknown', () => {
      const orch = createOrchestrator();
      expect(() => orch.broadcast('nope', 'hello')).toThrow(HarnessError);
    });

    it('enforces maxQueueSize limit on broadcast messages', () => {
      const orch = createOrchestrator({ maxQueueSize: 3 });
      orch.register('lead', 'Lead');
      orch.register('w1', 'Worker1');
      // Send 5 broadcasts, queue should be capped at 3
      for (let i = 0; i < 5; i++) {
        orch.broadcast('lead', `msg-${i}`);
      }
      const messages = orch.getMessages('w1');
      expect(messages).toHaveLength(3);
      // Should keep the most recent messages (drop oldest)
      expect(messages[0].content).toBe('msg-2');
      expect(messages[1].content).toBe('msg-3');
      expect(messages[2].content).toBe('msg-4');
    });

    it('emits message_sent events for each recipient', () => {
      const events: OrchestratorEvent[] = [];
      const orch = createOrchestrator();
      orch.register('lead', 'Lead');
      orch.register('w1', 'Worker1');
      orch.register('w2', 'Worker2');
      orch.onEvent((e) => events.push(e));
      orch.broadcast('lead', 'hello');
      const messageSent = events.filter((e) => e.type === 'message_sent');
      expect(messageSent).toHaveLength(2);
    });
  });

  describe('getChildren', () => {
    it('returns children of a parent agent', () => {
      const orch = createOrchestrator({ mode: 'hierarchical' });
      orch.register('lead', 'Lead');
      orch.register('w1', 'Worker1', { parentId: 'lead' });
      orch.register('w2', 'Worker2', { parentId: 'lead' });
      orch.register('w3', 'Worker3');
      const children = orch.getChildren('lead');
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id).sort()).toEqual(['w1', 'w2']);
    });

    it('returns empty array when no children exist', () => {
      const orch = createOrchestrator();
      orch.register('lead', 'Lead');
      expect(orch.getChildren('lead')).toHaveLength(0);
    });

    it('returns empty array for unknown parentId', () => {
      const orch = createOrchestrator();
      expect(orch.getChildren('nope')).toHaveLength(0);
    });
  });

  describe('shared context', () => {
    it('set and get values', () => {
      const orch = createOrchestrator();
      orch.context.set('key1', 'value1');
      expect(orch.context.get('key1')).toBe('value1');
    });

    it('get returns undefined for missing key', () => {
      const orch = createOrchestrator();
      expect(orch.context.get('nope')).toBeUndefined();
    });

    it('overwrites existing value', () => {
      const orch = createOrchestrator();
      orch.context.set('key1', 'value1');
      orch.context.set('key1', 'value2');
      expect(orch.context.get('key1')).toBe('value2');
    });

    it('entries returns all key-value pairs as ReadonlyMap', () => {
      const orch = createOrchestrator();
      orch.context.set('a', 1);
      orch.context.set('b', 2);
      const entries = orch.context.entries();
      expect(entries.size).toBe(2);
      expect(entries.get('a')).toBe(1);
      expect(entries.get('b')).toBe(2);
    });

    it('entries returns a snapshot (not a live reference)', () => {
      const orch = createOrchestrator();
      orch.context.set('a', 1);
      const snap = orch.context.entries();
      orch.context.set('b', 2);
      expect(snap.size).toBe(1);
    });

    it('emits context_updated event on set', () => {
      const events: OrchestratorEvent[] = [];
      const orch = createOrchestrator();
      orch.onEvent((e) => events.push(e));
      orch.context.set('key1', 'value1');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('context_updated');
      if (events[0].type === 'context_updated') {
        expect(events[0].key).toBe('key1');
      }
    });
  });

  describe('delegate', () => {
    it('returns undefined when no strategy is configured', async () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Worker');
      expect(await orch.delegate({ description: 'task1' })).toBeUndefined();
    });

    it('calls strategy.select and returns the agent ID', async () => {
      const strategy: DelegationStrategy = {
        select: vi.fn(() => 'a1'),
      };
      const orch = createOrchestrator({ strategy });
      orch.register('a1', 'Worker');
      const result = await orch.delegate({ description: 'task1' });
      expect(result).toBe('a1');
      expect(strategy.select).toHaveBeenCalledOnce();
    });

    it('returns undefined when strategy returns undefined', async () => {
      const strategy: DelegationStrategy = {
        select: vi.fn(() => undefined),
      };
      const orch = createOrchestrator({ strategy });
      orch.register('a1', 'Worker');
      expect(await orch.delegate({ description: 'task1' })).toBeUndefined();
    });

    it('emits task_delegated event when delegation succeeds', async () => {
      const events: OrchestratorEvent[] = [];
      const strategy: DelegationStrategy = {
        select: () => 'a1',
      };
      const orch = createOrchestrator({ strategy });
      orch.register('a1', 'Worker');
      orch.onEvent((e) => events.push(e));
      await orch.delegate({ description: 'build it' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task_delegated');
      if (events[0].type === 'task_delegated') {
        expect(events[0].agentId).toBe('a1');
        expect(events[0].task.description).toBe('build it');
      }
    });

    it('does not emit task_delegated when strategy returns undefined', async () => {
      const events: OrchestratorEvent[] = [];
      const strategy: DelegationStrategy = {
        select: () => undefined,
      };
      const orch = createOrchestrator({ strategy });
      orch.onEvent((e) => events.push(e));
      await orch.delegate({ description: 'task1' });
      expect(events).toHaveLength(0);
    });

    it('supports async strategy.select and returns a Promise', async () => {
      const strategy: DelegationStrategy = {
        select: async () => {
          return 'a1';
        },
      };
      const orch = createOrchestrator({ strategy });
      orch.register('a1', 'Worker');
      const result = await orch.delegate({ description: 'async task' });
      expect(result).toBe('a1');
    });

    it('delegate returns a Promise', () => {
      const strategy: DelegationStrategy = {
        select: () => 'a1',
      };
      const orch = createOrchestrator({ strategy });
      orch.register('a1', 'Worker');
      const result = orch.delegate({ description: 'task1' });
      expect(result).toBeInstanceOf(Promise);
    });

    it('passes all registered agents to strategy.select', async () => {
      const strategy: DelegationStrategy = {
        select: vi.fn(() => undefined),
      };
      const orch = createOrchestrator({ strategy });
      orch.register('a1', 'Worker1');
      orch.register('a2', 'Worker2');
      await orch.delegate({ description: 'task1', requirements: ['typescript'] });
      expect(strategy.select).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'a1' }),
          expect.objectContaining({ id: 'a2' }),
        ]),
        expect.objectContaining({ description: 'task1', requirements: ['typescript'] }),
      );
    });
  });

  describe('onEvent', () => {
    it('returns an unsubscribe function', () => {
      const events: OrchestratorEvent[] = [];
      const orch = createOrchestrator();
      const unsub = orch.onEvent((e) => events.push(e));
      expect(typeof unsub).toBe('function');

      orch.register('a1', 'Worker');
      expect(events).toHaveLength(1);

      unsub();
      orch.register('a2', 'Worker2');
      expect(events).toHaveLength(1); // No new events
    });

    it('supports multiple handlers', () => {
      const events1: OrchestratorEvent[] = [];
      const events2: OrchestratorEvent[] = [];
      const orch = createOrchestrator();
      orch.onEvent((e) => events1.push(e));
      orch.onEvent((e) => events2.push(e));
      orch.register('a1', 'Worker');
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });

    it('unsubscribe only removes that specific handler', () => {
      const events1: OrchestratorEvent[] = [];
      const events2: OrchestratorEvent[] = [];
      const orch = createOrchestrator();
      const unsub1 = orch.onEvent((e) => events1.push(e));
      orch.onEvent((e) => events2.push(e));
      orch.register('a1', 'Worker');
      unsub1();
      orch.register('a2', 'Worker2');
      expect(events1).toHaveLength(1); // Only first event
      expect(events2).toHaveLength(2); // Both events
    });
  });

  describe('dispose', () => {
    it('clears all agents, message queues, event handlers, and context', () => {
      const events: OrchestratorEvent[] = [];
      const orch = createOrchestrator();
      orch.register('a1', 'Worker1');
      orch.register('a2', 'Worker2');
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'hello' });
      orch.context.set('key1', 'value1');
      orch.onEvent((e) => events.push(e));

      // Verify state exists before dispose
      expect(orch.listAgents()).toHaveLength(2);
      expect(orch.getMessages('a2')).toHaveLength(1);
      expect(orch.context.get('key1')).toBe('value1');

      orch.dispose();

      // After dispose: agents cleared
      expect(orch.listAgents()).toHaveLength(0);
      expect(orch.getAgent('a1')).toBeUndefined();

      // After dispose: message queues cleared
      expect(orch.getMessages('a2')).toHaveLength(0);

      // After dispose: context cleared
      expect(orch.context.get('key1')).toBeUndefined();
      expect(orch.context.entries().size).toBe(0);

      // After dispose: event handlers cleared — registering a new agent should not emit to old handler
      const eventsBeforeDispose = events.length;
      orch.register('a3', 'Worker3');
      expect(events.length).toBe(eventsBeforeDispose);
    });
  });

  describe('default configuration', () => {
    it('defaults to peer mode', () => {
      const orch = createOrchestrator();
      // Peer mode should still work without errors
      orch.register('a1', 'Worker');
      orch.register('a2', 'Worker2');
      expect(orch.listAgents()).toHaveLength(2);
    });

    it('defaults to no maxAgents limit', () => {
      const orch = createOrchestrator();
      for (let i = 0; i < 50; i++) {
        orch.register(`a${i}`, `Worker${i}`);
      }
      expect(orch.listAgents()).toHaveLength(50);
    });
  });
});

describe('createBasicRoundRobinStrategy', () => {
  it('cycles through idle agents', () => {
    const strategy = createBasicRoundRobinStrategy();
    const agents: AgentRegistration[] = [
      { id: 'a1', name: 'W1', status: 'idle' },
      { id: 'a2', name: 'W2', status: 'idle' },
      { id: 'a3', name: 'W3', status: 'idle' },
    ];
    const task: DelegationTask = { description: 'task' };

    expect(strategy.select(agents, task)).toBe('a1');
    expect(strategy.select(agents, task)).toBe('a2');
    expect(strategy.select(agents, task)).toBe('a3');
    expect(strategy.select(agents, task)).toBe('a1'); // Wraps around
  });

  it('skips non-idle agents', () => {
    const strategy = createBasicRoundRobinStrategy();
    const agents: AgentRegistration[] = [
      { id: 'a1', name: 'W1', status: 'running' },
      { id: 'a2', name: 'W2', status: 'idle' },
      { id: 'a3', name: 'W3', status: 'completed' },
    ];
    const task: DelegationTask = { description: 'task' };

    expect(strategy.select(agents, task)).toBe('a2');
    expect(strategy.select(agents, task)).toBe('a2'); // Only one idle
  });

  it('returns undefined when no idle agents', () => {
    const strategy = createBasicRoundRobinStrategy();
    const agents: AgentRegistration[] = [
      { id: 'a1', name: 'W1', status: 'running' },
      { id: 'a2', name: 'W2', status: 'completed' },
    ];
    expect(strategy.select(agents, { description: 'task' })).toBeUndefined();
  });

  it('returns undefined for empty agent list', () => {
    const strategy = createBasicRoundRobinStrategy();
    expect(strategy.select([], { description: 'task' })).toBeUndefined();
  });

  it('integrates with orchestrator', async () => {
    const orch = createOrchestrator({ strategy: createBasicRoundRobinStrategy() });
    orch.register('a1', 'Worker1');
    orch.register('a2', 'Worker2');
    expect(await orch.delegate({ description: 'task1' })).toBe('a1');
    expect(await orch.delegate({ description: 'task2' })).toBe('a2');
    expect(await orch.delegate({ description: 'task3' })).toBe('a1');
  });
});

describe('createBasicRandomStrategy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('picks a random idle agent', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const strategy = createBasicRandomStrategy();
    const agents: AgentRegistration[] = [
      { id: 'a1', name: 'W1', status: 'idle' },
      { id: 'a2', name: 'W2', status: 'idle' },
    ];
    expect(strategy.select(agents, { description: 'task' })).toBe('a1');
  });

  it('skips non-idle agents', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const strategy = createBasicRandomStrategy();
    const agents: AgentRegistration[] = [
      { id: 'a1', name: 'W1', status: 'running' },
      { id: 'a2', name: 'W2', status: 'idle' },
    ];
    expect(strategy.select(agents, { description: 'task' })).toBe('a2');
  });

  it('returns undefined when no idle agents', () => {
    const strategy = createBasicRandomStrategy();
    const agents: AgentRegistration[] = [
      { id: 'a1', name: 'W1', status: 'running' },
    ];
    expect(strategy.select(agents, { description: 'task' })).toBeUndefined();
  });

  it('returns undefined for empty agent list', () => {
    const strategy = createBasicRandomStrategy();
    expect(strategy.select([], { description: 'task' })).toBeUndefined();
  });

  it('picks last agent when random is close to 1', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const strategy = createBasicRandomStrategy();
    const agents: AgentRegistration[] = [
      { id: 'a1', name: 'W1', status: 'idle' },
      { id: 'a2', name: 'W2', status: 'idle' },
    ];
    expect(strategy.select(agents, { description: 'task' })).toBe('a2');
  });

  it('integrates with orchestrator', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const orch = createOrchestrator({ strategy: createBasicRandomStrategy() });
    orch.register('a1', 'Worker1');
    orch.register('a2', 'Worker2');
    const result = await orch.delegate({ description: 'task' });
    expect(result).toBeDefined();
    expect(['a1', 'a2']).toContain(result);
  });
});

describe('createBasicFirstAvailableStrategy', () => {
  it('picks the first idle agent', () => {
    const strategy = createBasicFirstAvailableStrategy();
    const agents: AgentRegistration[] = [
      { id: 'a1', name: 'W1', status: 'running' },
      { id: 'a2', name: 'W2', status: 'idle' },
      { id: 'a3', name: 'W3', status: 'idle' },
    ];
    expect(strategy.select(agents, { description: 'task' })).toBe('a2');
  });

  it('returns undefined when no idle agents', () => {
    const strategy = createBasicFirstAvailableStrategy();
    const agents: AgentRegistration[] = [
      { id: 'a1', name: 'W1', status: 'running' },
      { id: 'a2', name: 'W2', status: 'failed' },
    ];
    expect(strategy.select(agents, { description: 'task' })).toBeUndefined();
  });

  it('returns undefined for empty agent list', () => {
    const strategy = createBasicFirstAvailableStrategy();
    expect(strategy.select([], { description: 'task' })).toBeUndefined();
  });

  it('always returns the same first idle agent', () => {
    const strategy = createBasicFirstAvailableStrategy();
    const agents: AgentRegistration[] = [
      { id: 'a1', name: 'W1', status: 'idle' },
      { id: 'a2', name: 'W2', status: 'idle' },
    ];
    expect(strategy.select(agents, { description: 't1' })).toBe('a1');
    expect(strategy.select(agents, { description: 't2' })).toBe('a1');
  });

  it('integrates with orchestrator', async () => {
    const orch = createOrchestrator({ strategy: createBasicFirstAvailableStrategy() });
    orch.register('a1', 'Worker1');
    orch.register('a2', 'Worker2');
    expect(await orch.delegate({ description: 'task' })).toBe('a1');
    orch.setStatus('a1', 'running');
    expect(await orch.delegate({ description: 'task2' })).toBe('a2');
  });
});

// Fix 23: Delegation cycle detection
describe('delegation cycle detection (Fix 23)', () => {
  it('detects delegation cycle via metadata', async () => {
    let callCount = 0;
    const strategy: DelegationStrategy = {
      select: () => {
        callCount++;
        // First call: delegate to a2
        // Second call: delegate back to a1 (cycle!)
        return callCount === 1 ? 'a2' : 'a1';
      },
    };
    const orch = createOrchestrator({ strategy });
    orch.register('a1', 'Worker1');
    orch.register('a2', 'Worker2');

    // First delegation: a1 delegates to a2 (no cycle)
    const result = await orch.delegate({ description: 'task', metadata: { delegatedFrom: 'a1' } });
    expect(result).toBe('a2');

    // Second delegation: a2 tries to delegate back to a1 (cycle!)
    await expect(
      orch.delegate({ description: 'task', metadata: { delegatedFrom: 'a2' } }),
    ).rejects.toThrow(HarnessError);
  });

  it('allows non-cyclic delegation chains', async () => {
    let callCount = 0;
    const strategy: DelegationStrategy = {
      select: () => {
        callCount++;
        return callCount === 1 ? 'a2' : 'a3';
      },
    };
    const orch = createOrchestrator({ strategy });
    orch.register('a1', 'Worker1');
    orch.register('a2', 'Worker2');
    orch.register('a3', 'Worker3');

    // a1 -> a2 (no cycle)
    await orch.delegate({ description: 'task', metadata: { delegatedFrom: 'a1' } });
    // a2 -> a3 (no cycle)
    const result = await orch.delegate({ description: 'task', metadata: { delegatedFrom: 'a2' } });
    expect(result).toBe('a3');
  });

  // concurrent delegations from the same source agent used to
  // race between the cycle-detection read and the delegationChain write. The
  // per-source-agent AsyncLock serialises the inspect+mutate window so that
  // two concurrent `delegate({ delegatedFrom: 'a1' })` calls against a chain
  // that would form a cycle cannot both sneak past the cycle check.
  it('concurrent delegations against a pre-existing chain both reject with CYCLE_DETECTED', async () => {
    // Pre-existing chain a2 -> a1: recorded via a single synchronous
    // delegation. Then fire two concurrent delegations a1 -> a2 — both must
    // be rejected because either one committing would create a cycle, and
    // the lock guarantees the second caller sees the first's (failed)
    // attempt's pre-state without being able to overlap the check+write.
    let strategyCall = 0;
    const strategy: DelegationStrategy = {
      select: async () => {
        strategyCall++;
        if (strategyCall === 1) return 'a1'; // first: a2 -> a1 (seed)
        // Subsequent calls yield a microtask so the two concurrent callers
        // interleave across the `await strategy.select()` inside delegate().
        await Promise.resolve();
        return 'a2'; // concurrent: a1 -> a2 would cycle
      },
    };
    const orch = createOrchestrator({ strategy });
    orch.register('a1', 'Worker1');
    orch.register('a2', 'Worker2');

    // Seed: a2 -> a1
    await orch.delegate({ description: 'seed', metadata: { delegatedFrom: 'a2' } });
    // Fire two concurrent a1 -> a2 delegations — both cycle.
    const results = await Promise.allSettled([
      orch.delegate({ description: 'c1', metadata: { delegatedFrom: 'a1' } }),
      orch.delegate({ description: 'c2', metadata: { delegatedFrom: 'a1' } }),
    ]);
    const rejections = results.filter((r) => r.status === 'rejected');
    expect(rejections.length).toBe(2);
    for (const r of rejections) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(HarnessError);
      expect(((r as PromiseRejectedResult).reason as HarnessError).code).toBe(HarnessErrorCode.ORCH_DELEGATION_CYCLE);
    }
  });
});

// Fix 34: Wrap onHandlerError
describe('onHandlerError wrapping (Fix 34)', () => {
  it('does not block other handlers when onHandlerError throws', () => {
    const events: OrchestratorEvent[] = [];
    const orch = createOrchestrator({
      onHandlerError: () => {
        throw new Error('Error handler itself throws');
      },
    });

    // First handler throws
    orch.onEvent(() => {
      throw new Error('Handler error');
    });

    // Second handler should still execute
    orch.onEvent((e) => events.push(e));

    orch.register('a1', 'Worker');

    // Second handler should have received the event despite first handler and error handler throwing
    expect(events.length).toBeGreaterThan(0);
  });

  // SEC-011: Prototype-polluting key rejection in contextStore.set
  describe('context.set key sanitization (SEC-011)', () => {
    it('rejects __proto__ with INVALID_KEY', () => {
      const orch = createOrchestrator();
      expect(() => orch.context.set('__proto__', { polluted: true })).toThrow(HarnessError);
      try {
        orch.context.set('__proto__', {});
      } catch (e) {
        expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_KEY);
      }
      // Object.prototype must NOT have been polluted
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('rejects "constructor" with INVALID_KEY', () => {
      const orch = createOrchestrator();
      expect(() => orch.context.set('constructor', 'x')).toThrow(HarnessError);
    });

    it('rejects "prototype" with INVALID_KEY', () => {
      const orch = createOrchestrator();
      expect(() => orch.context.set('prototype', 'x')).toThrow(HarnessError);
    });

    it('rejects empty string key', () => {
      const orch = createOrchestrator();
      expect(() => orch.context.set('', 'x')).toThrow(HarnessError);
    });

    it('allows safe user keys unchanged', () => {
      const orch = createOrchestrator();
      orch.context.set('user.name', 'Ada');
      expect(orch.context.get('user.name')).toBe('Ada');
    });
  });

  // `since` uses strict greater-than semantics
  describe('getMessages since semantics', () => {
    it('does NOT return the boundary message (strict >)', () => {
      const orch = createOrchestrator();
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');

      vi.spyOn(Date, 'now').mockReturnValue(2000);
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'at-2000' });

      // Passing the exact timestamp of the message should exclude it.
      const strictlyAfter = orch.getMessages('a2', { since: 2000 });
      expect(strictlyAfter).toHaveLength(0);

      // A slightly earlier `since` still returns the message.
      const before = orch.getMessages('a2', { since: 1999 });
      expect(before).toHaveLength(1);
    });
  });

  // droppedMessages counter exposed via getMetrics
  describe('getMetrics droppedMessages', () => {
    it('increments per drop and is reachable via getMetrics', () => {
      const orch = createOrchestrator({ maxQueueSize: 1 });
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');

      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'first' });
      // Queue cap = 1 → this push evicts "first".
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'second' });
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'third' });

      expect(orch.getMetrics().droppedMessages).toBeGreaterThanOrEqual(2);
    });

    it('calls logger.warn on drop when logger is configured', () => {
      const warn = vi.fn();
      const logger = {
        debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(),
        child() { return logger; },
      };
      const orch = createOrchestrator({ maxQueueSize: 1, logger });
      orch.register('a1', 'Sender');
      orch.register('a2', 'Receiver');
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'x' });
      orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'y' });
      expect(warn).toHaveBeenCalled();
    });
  });

  // Handler error routes to logger.warn when no onHandlerError
  describe('event handler error routing', () => {
    it('routes to logger.warn when onHandlerError absent', () => {
      const warn = vi.fn();
      const logger = {
        debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(),
        child() { return logger; },
      };
      const orch = createOrchestrator({ logger });
      orch.onEvent(() => { throw new Error('boom'); });
      orch.register('a1', 'X');
      expect(warn).toHaveBeenCalled();
    });
  });

  // eventHandlers Set allows O(1) unsubscribe
  describe('eventHandlers Set', () => {
    it('unsubscribe removes exactly one handler', () => {
      const orch = createOrchestrator();
      const received: unknown[] = [];
      const h = (): void => { received.push('h'); };
      const unsub = orch.onEvent(h);
      orch.register('a1', 'A');
      const afterFirst = received.length;
      unsub();
      orch.register('a2', 'B');
      expect(received.length).toBe(afterFirst);
    });
  });
});
