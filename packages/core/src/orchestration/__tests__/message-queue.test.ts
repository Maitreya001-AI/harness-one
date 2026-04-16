import { describe, it, expect } from 'vitest';
import { MessageQueue } from '../message-queue.js';
import { HarnessError, HarnessErrorCode} from '../../core/errors.js';
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

    // P2-22: `since` uses strict greater-than semantics — a message with
    // `timestamp === since` is excluded, matching the CQ-026 docstring.
    it('P2-22: since boundary is strict > — excludes messages with timestamp === since', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ timestamp: 1000, content: 'before' }));
      mq.push('a1', makeMessage({ timestamp: 1500, content: 'boundary' }));
      mq.push('a1', makeMessage({ timestamp: 2000, content: 'after' }));

      const result = mq.getMessages('a1', { since: 1500 });
      // Strict `>`: 1500 is excluded, only 2000 is returned.
      expect(result).toHaveLength(1);
      expect(result[0].timestamp).toBe(2000);
      expect(result[0].content).toBe('after');
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

  describe('dequeue', () => {
    it('removes and returns messages in FIFO order', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'first' }));
      mq.push('a1', makeMessage({ content: 'second' }));
      mq.push('a1', makeMessage({ content: 'third' }));

      const dequeued = mq.dequeue('a1');
      expect(dequeued).toHaveLength(3);
      expect(dequeued[0].content).toBe('first');
      expect(dequeued[1].content).toBe('second');
      expect(dequeued[2].content).toBe('third');

      // Queue should be empty after dequeue
      expect(mq.getMessages('a1')).toHaveLength(0);
    });

    it('dequeue(agentId, limit) returns at most limit messages', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'first' }));
      mq.push('a1', makeMessage({ content: 'second' }));
      mq.push('a1', makeMessage({ content: 'third' }));

      const dequeued = mq.dequeue('a1', 2);
      expect(dequeued).toHaveLength(2);
      expect(dequeued[0].content).toBe('first');
      expect(dequeued[1].content).toBe('second');

      // Remaining message should still be in queue
      const remaining = mq.getMessages('a1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].content).toBe('third');
    });

    it('dequeue() on empty queue returns empty array', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      const dequeued = mq.dequeue('a1');
      expect(dequeued).toEqual([]);
    });

    it('dequeue() on non-existent queue returns empty array', () => {
      const mq = new MessageQueue();
      const dequeued = mq.dequeue('nonexistent');
      expect(dequeued).toEqual([]);
    });

    it('dequeue with limit larger than queue size returns all messages', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'only' }));

      const dequeued = mq.dequeue('a1', 100);
      expect(dequeued).toHaveLength(1);
      expect(dequeued[0].content).toBe('only');
      expect(mq.getMessages('a1')).toHaveLength(0);
    });

    it('dequeue with limit 0 returns empty array', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'msg' }));

      const dequeued = mq.dequeue('a1', 0);
      expect(dequeued).toHaveLength(0);
      // Original message should still be in queue
      expect(mq.getMessages('a1')).toHaveLength(1);
    });

    it('multiple dequeue calls drain the queue progressively', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      for (let i = 0; i < 5; i++) {
        mq.push('a1', makeMessage({ content: `msg-${i}` }));
      }

      const batch1 = mq.dequeue('a1', 2);
      expect(batch1).toHaveLength(2);
      expect(batch1[0].content).toBe('msg-0');
      expect(batch1[1].content).toBe('msg-1');

      const batch2 = mq.dequeue('a1', 2);
      expect(batch2).toHaveLength(2);
      expect(batch2[0].content).toBe('msg-2');
      expect(batch2[1].content).toBe('msg-3');

      const batch3 = mq.dequeue('a1', 2);
      expect(batch3).toHaveLength(1);
      expect(batch3[0].content).toBe('msg-4');

      const batch4 = mq.dequeue('a1');
      expect(batch4).toHaveLength(0);
    });
  });

  describe('peek', () => {
    it('returns copies without removing messages', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'first' }));
      mq.push('a1', makeMessage({ content: 'second' }));

      const peeked = mq.peek('a1');
      expect(peeked).toHaveLength(2);
      expect(peeked[0].content).toBe('first');
      expect(peeked[1].content).toBe('second');

      // Messages should still be in queue
      expect(mq.getMessages('a1')).toHaveLength(2);

      // Peek again returns the same results
      const peeked2 = mq.peek('a1');
      expect(peeked2).toHaveLength(2);
    });

    it('peek(agentId, limit) returns at most limit messages', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'first' }));
      mq.push('a1', makeMessage({ content: 'second' }));
      mq.push('a1', makeMessage({ content: 'third' }));

      const peeked = mq.peek('a1', 2);
      expect(peeked).toHaveLength(2);
      expect(peeked[0].content).toBe('first');
      expect(peeked[1].content).toBe('second');

      // All messages still in queue
      expect(mq.getMessages('a1')).toHaveLength(3);
    });

    it('peek on empty queue returns empty array', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      expect(mq.peek('a1')).toEqual([]);
    });

    it('peek on non-existent queue returns empty array', () => {
      const mq = new MessageQueue();
      expect(mq.peek('nonexistent')).toEqual([]);
    });

    it('peek returns a new array (not the internal queue reference)', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'msg' }));

      const peeked = mq.peek('a1');
      // Modifying the returned array should not affect the queue
      peeked.length = 0;
      expect(mq.peek('a1')).toHaveLength(1);
    });
  });

  describe('size', () => {
    it('returns correct count', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      expect(mq.size('a1')).toBe(0);

      mq.push('a1', makeMessage({ content: 'first' }));
      expect(mq.size('a1')).toBe(1);

      mq.push('a1', makeMessage({ content: 'second' }));
      expect(mq.size('a1')).toBe(2);
    });

    it('returns 0 for non-existent queue', () => {
      const mq = new MessageQueue();
      expect(mq.size('nonexistent')).toBe(0);
    });

    it('returns 0 after clearing', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage());
      mq.push('a1', makeMessage());
      mq.clear();
      expect(mq.size('a1')).toBe(0);
    });

    it('reflects size after drop-oldest overflow', () => {
      const mq = new MessageQueue({ maxQueueSize: 3 });
      mq.createQueue('a1');
      for (let i = 0; i < 10; i++) {
        mq.push('a1', makeMessage({ content: `msg-${i}` }));
      }
      expect(mq.size('a1')).toBe(3);
    });
  });

  describe('dequeue + size consistency', () => {
    it('size decreases after dequeue', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'first' }));
      mq.push('a1', makeMessage({ content: 'second' }));
      mq.push('a1', makeMessage({ content: 'third' }));

      expect(mq.size('a1')).toBe(3);

      mq.dequeue('a1', 1);
      expect(mq.size('a1')).toBe(2);

      mq.dequeue('a1', 1);
      expect(mq.size('a1')).toBe(1);

      mq.dequeue('a1');
      expect(mq.size('a1')).toBe(0);
    });

    it('peek does not affect size', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage());
      mq.push('a1', makeMessage());

      expect(mq.size('a1')).toBe(2);
      mq.peek('a1');
      expect(mq.size('a1')).toBe(2);
      mq.peek('a1', 1);
      expect(mq.size('a1')).toBe(2);
    });

    it('dequeue + push + size stays consistent', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');

      for (let i = 0; i < 5; i++) {
        mq.push('a1', makeMessage({ content: `msg-${i}` }));
      }
      expect(mq.size('a1')).toBe(5);

      mq.dequeue('a1', 3);
      expect(mq.size('a1')).toBe(2);

      mq.push('a1', makeMessage({ content: 'new-1' }));
      mq.push('a1', makeMessage({ content: 'new-2' }));
      expect(mq.size('a1')).toBe(4);

      const all = mq.dequeue('a1');
      expect(all).toHaveLength(4);
      expect(mq.size('a1')).toBe(0);
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
        expect((e as HarnessError).code).toBe(HarnessErrorCode.ORCH_QUEUE_FULL);
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

    // P2-10: Pin down backpressure semantics — when the queue is full and
    // backpressure is enabled, push() throws and onEvent is NOT called
    // (backpressure throws instead of dropping, so there's no drop event).
    it('P2-10: throws and does NOT call onEvent when backpressure is enabled and queue is full', () => {
      const events: Array<{ type: string; agentId: string; droppedCount: number }> = [];
      const warnings: unknown[] = [];
      const mq = new MessageQueue({
        maxQueueSize: 1,
        backpressure: true,
        onEvent: (e) => events.push(e),
        onWarning: (w) => warnings.push(w),
      });
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'first' }));

      // push throws due to backpressure...
      expect(() => mq.push('a1', makeMessage({ content: 'second' }))).toThrow(HarnessError);
      // ...and onEvent is NOT called (no drop occurred; backpressure is the signal)
      expect(events).toHaveLength(0);
      // ...and onWarning is NOT called either (rejection is the signal)
      expect(warnings).toHaveLength(0);

      // The original message should remain untouched.
      const remaining = mq.getMessages('a1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].content).toBe('first');
    });
  });

  describe('PERF-031: iterateMessages zero-copy generator', () => {
    it('yields messages in FIFO order without copying the underlying queue', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      const m1 = makeMessage({ content: 'm1' });
      const m2 = makeMessage({ content: 'm2' });
      mq.push('a1', m1);
      mq.push('a1', m2);

      const collected: AgentMessage[] = [];
      for (const msg of mq.iterateMessages('a1')) collected.push(msg);

      expect(collected).toHaveLength(2);
      expect(collected[0]).toBe(m1);
      expect(collected[1]).toBe(m2);
    });

    it('applies the same type/since filters as getMessages', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ type: 'request', timestamp: 100 }));
      mq.push('a1', makeMessage({ type: 'response', timestamp: 200 }));
      mq.push('a1', makeMessage({ type: 'request', timestamp: 300 }));

      const requestsAfter100 = [
        ...mq.iterateMessages('a1', { type: 'request', since: 100 }),
      ];
      expect(requestsAfter100.map((m) => m.timestamp)).toEqual([300]);
    });

    it('yields nothing for an unknown agent', () => {
      const mq = new MessageQueue();
      const collected = [...mq.iterateMessages('nope')];
      expect(collected).toEqual([]);
    });

    it('captures queue length at iterator start (concurrent push is skipped)', () => {
      const mq = new MessageQueue();
      mq.createQueue('a1');
      mq.push('a1', makeMessage({ content: 'a' }));
      mq.push('a1', makeMessage({ content: 'b' }));

      const iter = mq.iterateMessages('a1');
      const first = iter.next();
      expect(first.value?.content).toBe('a');

      // Push a new message while iterating — should be ignored by this iterator.
      mq.push('a1', makeMessage({ content: 'c' }));

      const rest: AgentMessage[] = [];
      for (const m of iter) rest.push(m);
      expect(rest.map((m) => m.content)).toEqual(['b']);
    });
  });
});
