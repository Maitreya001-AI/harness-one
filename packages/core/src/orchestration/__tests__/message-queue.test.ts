import { describe, it, expect } from 'vitest';
import { MessageQueue } from '../message-queue.js';
import { HarnessError } from '../../core/errors.js';
import type { AgentMessage } from '../types.js';

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    from: 'sender',
    to: 'receiver',
    type: 'request',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('MessageQueue', () => {
  describe('createQueue / deleteQueue / hasQueue', () => {
    it('creates a queue for an agent', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      expect(mq.hasQueue('a1')).toBe(true);
    });

    it('deleteQueue removes the queue', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      expect(mq.deleteQueue('a1')).toBe(true);
      expect(mq.hasQueue('a1')).toBe(false);
    });

    it('deleteQueue returns false for non-existent queue', () => {
      const mq = new MessageQueue();
      expect(mq.deleteQueue('nope')).toBe(false);
    });

    it('hasQueue returns false for non-existent agent', () => {
      const mq = new MessageQueue();
      expect(mq.hasQueue('nope')).toBe(false);
    });
  });

  describe('push', () => {
    it('pushes a message to an agent queue', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      const msg = makeMessage({ to: 'a1' });
      expect(mq.push('a1', msg)).toBe(true);
      expect(mq.getMessages('a1')).toHaveLength(1);
      expect(mq.getMessages('a1')[0]).toBe(msg);
    });

    it('returns false when agent has no queue', () => {
      const mq = new MessageQueue();
      expect(mq.push('nope', makeMessage())).toBe(false);
    });

    it('drops oldest message when queue is full (drop-oldest policy)', () => {
      const mq = new MessageQueue({ maxQueueSize: 2 });
      mq.createQueue('a1');
      const msg1 = makeMessage({ content: 'first', to: 'a1' });
      const msg2 = makeMessage({ content: 'second', to: 'a1' });
      const msg3 = makeMessage({ content: 'third', to: 'a1' });
      mq.push('a1', msg1);
      mq.push('a1', msg2);
      mq.push('a1', msg3); // drops msg1
      const messages = mq.getMessages('a1');
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('second');
      expect(messages[1].content).toBe('third');
    });

    it('calls onWarning when a message is dropped', () => {
      const warnings: Array<{ message: string; droppedCount: number; queueSize: number }> = [];
      const mq = new MessageQueue({
        maxQueueSize: 1,
        onWarning: (w) => warnings.push(w),
      });
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'first' }));
      mq.push('a1', makeMessage({ content: 'second' })); // triggers drop
      expect(warnings).toHaveLength(1);
      expect(warnings[0].droppedCount).toBe(1);
      expect(warnings[0].queueSize).toBe(1);
      expect(warnings[0].message).toContain('a1');
    });

    it('calls onEvent when a message is dropped', () => {
      const events: Array<{ type: string; agentId: string; droppedCount: number }> = [];
      const mq = new MessageQueue({
        maxQueueSize: 1,
        onEvent: (e) => events.push(e),
      });
      mq.createQueue('a1');
      mq.push('a1', makeMessage());
      mq.push('a1', makeMessage()); // triggers drop
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message_dropped');
      expect(events[0].agentId).toBe('a1');
      expect(events[0].droppedCount).toBe(1);
    });

    it('continues accepting messages after drops', () => {
      const mq = new MessageQueue({ maxQueueSize: 2 });
      mq.createQueue('a1');
      for (let i = 0; i < 10; i++) {
        mq.push('a1', makeMessage({ content: `msg-${i}` }));
      }
      const messages = mq.getMessages('a1');
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('msg-8');
      expect(messages[1].content).toBe('msg-9');
    });
  });

  describe('getMessages', () => {
    it('returns empty array for agent with no queue', () => {
      const mq = new MessageQueue();
      expect(mq.getMessages('nope')).toEqual([]);
    });

    it('returns empty array for agent with empty queue', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      expect(mq.getMessages('a1')).toEqual([]);
    });

    it('filters by type', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ type: 'request', content: 'req' }));
      mq.push('a1', makeMessage({ type: 'response', content: 'res' }));
      const requests = mq.getMessages('a1', { type: 'request' });
      expect(requests).toHaveLength(1);
      expect(requests[0].content).toBe('req');
    });

    it('filters by since timestamp', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ timestamp: 1000, content: 'old' }));
      mq.push('a1', makeMessage({ timestamp: 2000, content: 'new' }));
      const recent = mq.getMessages('a1', { since: 1500 });
      expect(recent).toHaveLength(1);
      expect(recent[0].content).toBe('new');
    });

    it('filters by both type and since', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ type: 'request', timestamp: 1000, content: 'old-req' }));
      mq.push('a1', makeMessage({ type: 'response', timestamp: 2000, content: 'new-res' }));
      mq.push('a1', makeMessage({ type: 'request', timestamp: 2000, content: 'new-req' }));
      const result = mq.getMessages('a1', { type: 'request', since: 1500 });
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('new-req');
    });
  });

  describe('clear', () => {
    it('removes all queues', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.createQueue('a2');
      mq.push('a1', makeMessage());
      mq.push('a2', makeMessage());
      mq.clear();
      expect(mq.hasQueue('a1')).toBe(false);
      expect(mq.hasQueue('a2')).toBe(false);
    });
  });

  describe('push atomicity (C3: documentation-only — verifies synchronous safety)', () => {
    it('push is synchronous: check+modify is atomic within a single call', () => {
      // This test verifies that the synchronous check+modify in push() is safe
      // because JS is single-threaded. The push method reads queue.length, shifts
      // if full, then pushes — all in one synchronous call with no interleaving.
      const mq = new MessageQueue({ maxQueueSize: 2 });
      mq.createQueue('a1');

      // Fill to capacity
      mq.push('a1', makeMessage({ content: 'first' }));
      mq.push('a1', makeMessage({ content: 'second' }));

      // Push one more — triggers drop-oldest, then push — atomically
      const accepted = mq.push('a1', makeMessage({ content: 'third' }));
      expect(accepted).toBe(true);

      const messages = mq.getMessages('a1');
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('second');
      expect(messages[1].content).toBe('third');
    });
  });

  describe('default maxQueueSize', () => {
    it('defaults to 1000', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      for (let i = 0; i < 1001; i++) {
        mq.push('a1', makeMessage({ content: `msg-${i}` }));
      }
      expect(mq.getMessages('a1')).toHaveLength(1000);
      // Oldest (msg-0) should be dropped, newest (msg-1000) should exist
      expect(mq.getMessages('a1')[999].content).toBe('msg-1000');
    });
  });

  // Fix 26: Backpressure option
  describe('backpressure option (Fix 26)', () => {
    it('throws QUEUE_FULL when backpressure is enabled and queue is full', () => {
      const mq = new MessageQueue({ maxQueueSize: 2, backpressure: true });
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'first' }));
      mq.push('a1', makeMessage({ content: 'second' }));

      expect(() => mq.push('a1', makeMessage({ content: 'third' }))).toThrow(HarnessError);
      try {
        mq.push('a1', makeMessage({ content: 'third' }));
      } catch (e) {
        expect((e as HarnessError).code).toBe('QUEUE_FULL');
      }

      // Queue should still have original 2 messages
      expect(mq.getMessages('a1')).toHaveLength(2);
      expect(mq.getMessages('a1')[0].content).toBe('first');
    });

    it('uses drop-oldest by default (backpressure=false)', () => {
      const mq = new MessageQueue({ maxQueueSize: 2 });
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'first' }));
      mq.push('a1', makeMessage({ content: 'second' }));
      mq.push('a1', makeMessage({ content: 'third' })); // drops first

      expect(mq.getMessages('a1')).toHaveLength(2);
      expect(mq.getMessages('a1')[0].content).toBe('second');
    });

    it('backpressure mode does not call onWarning (rejection is the signal)', () => {
      const warnings: unknown[] = [];
      const mq = new MessageQueue({
        maxQueueSize: 1,
        backpressure: true,
        onWarning: (w) => warnings.push(w),
      });
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'first' }));

      expect(() => mq.push('a1', makeMessage({ content: 'second' }))).toThrow();
      expect(warnings).toHaveLength(0);
    });
  });
});
