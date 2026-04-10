import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHandoff } from '../handoff.js';
import { createOrchestrator } from '../orchestrator.js';
import type { AgentOrchestrator } from '../orchestrator.js';
import type { HandoffManager, HandoffPayload, MessageTransport } from '../types.js';

describe('createHandoff', () => {
  let orchestrator: AgentOrchestrator;
  let handoff: HandoffManager;

  beforeEach(() => {
    orchestrator = createOrchestrator();
    orchestrator.register('agent-a', 'Agent A');
    orchestrator.register('agent-b', 'Agent B');
    handoff = createHandoff(orchestrator);
  });

  it('send() returns a frozen HandoffReceipt', () => {
    const payload: HandoffPayload = { summary: 'Do task X' };
    const receipt = handoff.send('agent-a', 'agent-b', payload);

    expect(receipt.id).toBe('handoff-0');
    expect(receipt.from).toBe('agent-a');
    expect(receipt.to).toBe('agent-b');
    expect(receipt.timestamp).toBeGreaterThan(0);
    expect(receipt.payload.summary).toBe('Do task X');
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it('receive() returns payloads in FIFO order', () => {
    handoff.send('agent-a', 'agent-b', { summary: 'First' });
    handoff.send('agent-a', 'agent-b', { summary: 'Second' });

    const first = handoff.receive('agent-b');
    const second = handoff.receive('agent-b');

    expect(first?.summary).toBe('First');
    expect(second?.summary).toBe('Second');
  });

  it('receive() returns undefined when inbox is empty', () => {
    expect(handoff.receive('agent-b')).toBeUndefined();
  });

  it('history() returns receipts for sender and receiver', () => {
    handoff.send('agent-a', 'agent-b', { summary: 'Task 1' });
    handoff.send('agent-b', 'agent-a', { summary: 'Task 2' });

    const historyA = handoff.history('agent-a');
    const historyB = handoff.history('agent-b');

    expect(historyA).toHaveLength(2);
    expect(historyB).toHaveLength(2);
  });

  it('verify() returns passed:true when all criteria pass', () => {
    const receipt = handoff.send('agent-a', 'agent-b', {
      summary: 'Task',
      acceptanceCriteria: ['criterion-1', 'criterion-2'],
    });

    const result = handoff.verify(receipt.id, 'output', () => true);

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('verify() returns passed:false with violations list', () => {
    const receipt = handoff.send('agent-a', 'agent-b', {
      summary: 'Task',
      acceptanceCriteria: ['must-pass', 'must-fail'],
    });

    const result = handoff.verify(receipt.id, 'output', (c) => c === 'must-pass');

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(['must-fail']);
  });

  it('verify() returns passed:true when no acceptance criteria', () => {
    const receipt = handoff.send('agent-a', 'agent-b', { summary: 'No criteria' });

    const result = handoff.verify(receipt.id, 'output', () => false);

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('verify() returns passed:false for unknown receipt ID', () => {
    const result = handoff.verify('nonexistent', 'output', () => true);

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(['Unknown receipt ID']);
  });

  it('dispose() clears all state', () => {
    handoff.send('agent-a', 'agent-b', { summary: 'Task' });
    handoff.dispose();

    expect(handoff.receive('agent-b')).toBeUndefined();
    expect(handoff.history('agent-a')).toHaveLength(0);
  });

  it('payload is frozen', () => {
    handoff.send('agent-a', 'agent-b', { summary: 'Frozen test' });
    const payload = handoff.receive('agent-b');

    expect(payload).toBeDefined();
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it('receipts are pruned when exceeding max capacity', () => {
    for (let i = 0; i < 10_050; i++) {
      handoff.send('agent-a', 'agent-b', { summary: `msg-${i}` });
    }
    // receipts should be capped at 10,000
    const history = handoff.history('agent-a');
    expect(history.length).toBeLessThanOrEqual(10_000);
  });

  it('send() throws HANDOFF_SERIALIZATION_ERROR for non-serializable payload', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      handoff.send('agent-a', 'agent-b', { summary: 'test', context: circular }),
    ).toThrow(/HANDOFF_SERIALIZATION_ERROR|serialize/i);
  });

  it('inbox per agent is pruned when exceeding max capacity', () => {
    for (let i = 0; i < 1_050; i++) {
      handoff.send('agent-a', 'agent-b', { summary: `msg-${i}` });
    }
    // Drain the inbox and count
    let count = 0;
    while (handoff.receive('agent-b') !== undefined) {
      count++;
    }
    expect(count).toBeLessThanOrEqual(1_000);
  });

  describe('MessageTransport interface', () => {
    it('accepts a minimal MessageTransport instead of full orchestrator', () => {
      const transport: MessageTransport = {
        send: vi.fn(),
      };
      const h = createHandoff(transport);
      const receipt = h.send('a', 'b', { summary: 'via transport' });

      expect(receipt.from).toBe('a');
      expect(receipt.to).toBe('b');
      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'a',
          to: 'b',
          type: 'request',
        }),
      );
    });

    it('receive works with a minimal MessageTransport', () => {
      const transport: MessageTransport = { send: vi.fn() };
      const h = createHandoff(transport);

      h.send('a', 'b', { summary: 'first' });
      h.send('a', 'b', { summary: 'second' });

      expect(h.receive('b')?.summary).toBe('first');
      expect(h.receive('b')?.summary).toBe('second');
      expect(h.receive('b')).toBeUndefined();
    });

    it('verify works with a minimal MessageTransport', () => {
      const transport: MessageTransport = { send: vi.fn() };
      const h = createHandoff(transport);

      const receipt = h.send('a', 'b', {
        summary: 'task',
        acceptanceCriteria: ['must-pass', 'must-fail'],
      });

      const result = h.verify(receipt.id, 'output', (c) => c === 'must-pass');
      expect(result.passed).toBe(false);
      expect(result.violations).toEqual(['must-fail']);
    });

    it('history and dispose work with a minimal MessageTransport', () => {
      const transport: MessageTransport = { send: vi.fn() };
      const h = createHandoff(transport);

      h.send('a', 'b', { summary: 'task' });
      expect(h.history('a')).toHaveLength(1);

      h.dispose();
      expect(h.history('a')).toHaveLength(0);
      expect(h.receive('b')).toBeUndefined();
    });

    it('AgentOrchestrator satisfies MessageTransport (backward compat)', () => {
      // This is the existing pattern — it should continue to work
      const orch = createOrchestrator();
      orch.register('x', 'Agent X');
      orch.register('y', 'Agent Y');

      const h = createHandoff(orch);
      const receipt = h.send('x', 'y', { summary: 'compat test' });

      expect(receipt.from).toBe('x');
      expect(h.receive('y')?.summary).toBe('compat test');
    });
  });
});
