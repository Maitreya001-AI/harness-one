import { describe, it, expect, vi } from 'vitest';
import { createInMemoryConversationStore } from '../conversation-store.js';
import type { Message } from '../../core/types.js';

describe('createInMemoryConversationStore', () => {
  const userMsg: Message = { role: 'user', content: 'Hello' };
  const assistantMsg: Message = { role: 'assistant', content: 'Hi there!' };

  describe('save / load', () => {
    it('saves and loads messages for a session', async () => {
      const store = createInMemoryConversationStore();
      await store.save('s1', [userMsg, assistantMsg]);
      const loaded = await store.load('s1');
      expect(loaded).toEqual([userMsg, assistantMsg]);
    });

    it('returns empty array for unknown session', async () => {
      const store = createInMemoryConversationStore();
      const loaded = await store.load('nonexistent');
      expect(loaded).toEqual([]);
    });

    it('overwrites previous messages on save', async () => {
      const store = createInMemoryConversationStore();
      await store.save('s1', [userMsg]);
      await store.save('s1', [assistantMsg]);
      const loaded = await store.load('s1');
      expect(loaded).toEqual([assistantMsg]);
    });

    it('returns a defensive copy (mutations do not affect store)', async () => {
      const store = createInMemoryConversationStore();
      await store.save('s1', [userMsg]);

      const loaded = await store.load('s1');
      loaded.push(assistantMsg);

      const loaded2 = await store.load('s1');
      expect(loaded2).toEqual([userMsg]);
    });

    it('saves a defensive copy of input array', async () => {
      const store = createInMemoryConversationStore();
      const messages: Message[] = [userMsg];
      await store.save('s1', messages);

      // Mutating the original array should not affect the store
      messages.push(assistantMsg);
      const loaded = await store.load('s1');
      expect(loaded).toEqual([userMsg]);
    });
  });

  describe('append', () => {
    it('appends a message to an existing session', async () => {
      const store = createInMemoryConversationStore();
      await store.save('s1', [userMsg]);
      await store.append('s1', assistantMsg);
      const loaded = await store.load('s1');
      expect(loaded).toEqual([userMsg, assistantMsg]);
    });

    it('creates session if it does not exist', async () => {
      const store = createInMemoryConversationStore();
      await store.append('new', userMsg);
      const loaded = await store.load('new');
      expect(loaded).toEqual([userMsg]);
    });

    it('appends multiple messages sequentially', async () => {
      const store = createInMemoryConversationStore();
      await store.append('s1', userMsg);
      await store.append('s1', assistantMsg);
      await store.append('s1', { role: 'user', content: 'Follow up' });
      const loaded = await store.load('s1');
      expect(loaded).toHaveLength(3);
    });

    it('does not mutate previously loaded arrays after append', async () => {
      const store = createInMemoryConversationStore();
      await store.save('s1', [userMsg]);
      const before = await store.load('s1');
      await store.append('s1', assistantMsg);
      // The previously loaded array should not have been mutated
      expect(before).toEqual([userMsg]);
      expect(before).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it('deletes an existing session and returns true', async () => {
      const store = createInMemoryConversationStore();
      await store.save('s1', [userMsg]);
      const result = await store.delete('s1');
      expect(result).toBe(true);
    });

    it('returns false for nonexistent session', async () => {
      const store = createInMemoryConversationStore();
      const result = await store.delete('nonexistent');
      expect(result).toBe(false);
    });

    it('load returns empty after delete', async () => {
      const store = createInMemoryConversationStore();
      await store.save('s1', [userMsg]);
      await store.delete('s1');
      const loaded = await store.load('s1');
      expect(loaded).toEqual([]);
    });
  });

  describe('list', () => {
    it('lists all session IDs', async () => {
      const store = createInMemoryConversationStore();
      await store.save('s1', [userMsg]);
      await store.save('s2', [assistantMsg]);
      const ids = await store.list();
      expect(ids).toContain('s1');
      expect(ids).toContain('s2');
      expect(ids).toHaveLength(2);
    });

    it('returns empty array when no sessions exist', async () => {
      const store = createInMemoryConversationStore();
      const ids = await store.list();
      expect(ids).toEqual([]);
    });

    it('reflects deletions', async () => {
      const store = createInMemoryConversationStore();
      await store.save('s1', [userMsg]);
      await store.save('s2', [assistantMsg]);
      await store.delete('s1');
      const ids = await store.list();
      expect(ids).toEqual(['s2']);
    });
  });

  // Fix 14: Document multi-process safety — verify single-process append works correctly
  describe('single-process append safety', () => {
    it('sequential appends do not lose messages', async () => {
      const store = createInMemoryConversationStore();
      await store.append('s1', { role: 'user', content: 'msg1' });
      await store.append('s1', { role: 'assistant', content: 'msg2' });
      await store.append('s1', { role: 'user', content: 'msg3' });

      const loaded = await store.load('s1');
      expect(loaded).toHaveLength(3);
      expect(loaded[0].content).toBe('msg1');
      expect(loaded[1].content).toBe('msg2');
      expect(loaded[2].content).toBe('msg3');
    });
  });

  describe('isolation between sessions', () => {
    it('sessions do not interfere with each other', async () => {
      const store = createInMemoryConversationStore();
      await store.save('s1', [userMsg]);
      await store.save('s2', [assistantMsg]);

      expect(await store.load('s1')).toEqual([userMsg]);
      expect(await store.load('s2')).toEqual([assistantMsg]);
    });
  });

  // CQ-011: Bounded in-memory conversation store
  describe('CQ-011: bounded store', () => {
    it('defaults to unlimited (backwards compatible)', async () => {
      const store = createInMemoryConversationStore();
      for (let i = 0; i < 50; i++) {
        await store.save(`s${i}`, [userMsg]);
      }
      expect((await store.list()).length).toBe(50);
    });

    it('LRU-evicts oldest session once maxSessions exceeded', async () => {
      const store = createInMemoryConversationStore({ maxSessions: 3 });
      await store.save('a', [userMsg]);
      await store.save('b', [userMsg]);
      await store.save('c', [userMsg]);
      await store.save('d', [userMsg]); // evicts "a"
      const ids = await store.list();
      expect(ids).toEqual(expect.arrayContaining(['b', 'c', 'd']));
      expect(ids).not.toContain('a');
    });

    it('LRU touch on append resets recency', async () => {
      const store = createInMemoryConversationStore({ maxSessions: 3 });
      await store.save('a', [userMsg]);
      await store.save('b', [userMsg]);
      await store.save('c', [userMsg]);
      // Touch "a" so it becomes the newest — "b" should be evicted next.
      await store.append('a', assistantMsg);
      await store.save('d', [userMsg]);
      const ids = await store.list();
      expect(ids).toContain('a');
      expect(ids).not.toContain('b');
    });

    it('truncates oldest messages when maxMessagesPerSession exceeded (save path)', async () => {
      const store = createInMemoryConversationStore({ maxMessagesPerSession: 2 });
      const msg = (text: string): Message => ({ role: 'user', content: text });
      await store.save('s', [msg('1'), msg('2'), msg('3'), msg('4')]);
      const loaded = await store.load('s');
      expect(loaded).toHaveLength(2);
      expect(loaded.map((m) => m.content)).toEqual(['3', '4']);
    });

    it('truncates oldest messages when maxMessagesPerSession exceeded (append path)', async () => {
      const store = createInMemoryConversationStore({ maxMessagesPerSession: 2 });
      const msg = (text: string): Message => ({ role: 'user', content: text });
      await store.append('s', msg('1'));
      await store.append('s', msg('2'));
      await store.append('s', msg('3'));
      const loaded = await store.load('s');
      expect(loaded).toHaveLength(2);
      expect(loaded.map((m) => m.content)).toEqual(['2', '3']);
    });

    it('warns once when unbounded and threshold crossed', async () => {
      const onWarning = vi.fn();
      const store = createInMemoryConversationStore({
        onWarning,
        unboundedWarnThreshold: 3,
      });
      for (let i = 0; i < 5; i++) {
        await store.save(`s${i}`, [userMsg]);
      }
      // Fired exactly once (one-time warn).
      expect(onWarning).toHaveBeenCalledTimes(1);
    });

    it('does not warn when bounds are set explicitly', async () => {
      const onWarning = vi.fn();
      const store = createInMemoryConversationStore({
        onWarning,
        maxSessions: 2,
        unboundedWarnThreshold: 1,
      });
      await store.save('a', [userMsg]);
      await store.save('b', [userMsg]);
      await store.save('c', [userMsg]);
      expect(onWarning).not.toHaveBeenCalled();
    });
  });
});
