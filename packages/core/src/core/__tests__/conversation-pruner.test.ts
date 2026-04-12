import { describe, it, expect } from 'vitest';
import { pruneConversation } from '../conversation-pruner.js';
import type { Message } from '../types.js';

describe('pruneConversation', () => {
  describe('no pruning needed', () => {
    it('returns the conversation unchanged when within the limit', () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ];
      const result = pruneConversation(messages, 10);
      expect(result.pruned).toEqual(messages);
      expect(result.warning).toBeUndefined();
    });

    it('returns unchanged when exactly at the limit', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ];
      const result = pruneConversation(messages, 2);
      expect(result.pruned).toEqual(messages);
      expect(result.warning).toBeUndefined();
    });
  });

  describe('basic pruning', () => {
    it('preserves system messages and takes the tail', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'reply3' },
      ];
      const result = pruneConversation(messages, 4);
      // system + 3 tail messages
      expect(result.pruned).toHaveLength(4);
      expect(result.pruned[0]).toEqual({ role: 'system', content: 'System prompt' });
      expect(result.pruned[result.pruned.length - 1]).toEqual({ role: 'assistant', content: 'reply3' });
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('7');
      expect(result.warning).toContain('4');
    });

    it('preserves multiple leading system messages', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System 1' },
        { role: 'system', content: 'System 2' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
      ];
      const result = pruneConversation(messages, 4);
      expect(result.pruned).toHaveLength(4);
      expect(result.pruned[0]).toEqual({ role: 'system', content: 'System 1' });
      expect(result.pruned[1]).toEqual({ role: 'system', content: 'System 2' });
    });

    it('handles conversation with no system messages', () => {
      const messages: Message[] = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'reply3' },
      ];
      // When no system messages, head has at least 1 element (first msg)
      const result = pruneConversation(messages, 3);
      expect(result.pruned).toHaveLength(3);
      expect(result.warning).toBeDefined();
    });
  });

  describe('orphaned tool message cleanup', () => {
    it('drops orphaned tool messages at the start of the tail', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'ask tool', toolCalls: [{ id: 'tc1', name: 'search', arguments: '{}' }] },
        { role: 'tool', content: 'tool result', toolCallId: 'tc1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
      ];
      // maxMessages = 3: system + 2 tail
      // tail from slice(-2) = [tool (tc1), user (msg2)] if the tool msg would be at start
      // But pruning logic should drop the orphaned tool msg
      const result = pruneConversation(messages, 3);
      // After dropping orphaned tool, should contain system + remaining valid messages
      const hasOrphanedTool = result.pruned.some(
        (m, i) => i > 0 && m.role === 'tool' && !result.pruned.slice(0, i).some(
          prev => prev.role === 'assistant' && prev.toolCalls?.some(tc => tc.id === (m as { toolCallId: string }).toolCallId)
        )
      );
      expect(hasOrphanedTool).toBe(false);
    });

    it('drops consecutive orphaned tool messages at the start', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'a', arguments: '{}' }, { id: 'tc2', name: 'b', arguments: '{}' }] },
        { role: 'tool', content: 'result1', toolCallId: 'tc1' },
        { role: 'tool', content: 'result2', toolCallId: 'tc2' },
        { role: 'user', content: 'msg' },
        { role: 'assistant', content: 'reply' },
      ];
      // Force pruning that puts tool messages at the start of the tail
      const result = pruneConversation(messages, 3);
      // Should not start with tool messages in the tail portion
      expect(result.pruned.filter(m => m.role !== 'system')[0]?.role).not.toBe('tool');
    });
  });

  describe('incomplete tool call cleanup', () => {
    it('drops assistant message with tool calls when results are missing', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'search', arguments: '{}' }] },
        { role: 'tool', content: 'result', toolCallId: 'tc1' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc2', name: 'read', arguments: '{}' }, { id: 'tc3', name: 'write', arguments: '{}' }] },
        { role: 'tool', content: 'result2', toolCallId: 'tc2' },
        { role: 'tool', content: 'result3', toolCallId: 'tc3' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'final reply' },
      ];

      // If pruning causes the tail to start with an assistant that has tool calls
      // but not all tool results are present, drop the assistant and orphaned tools
      // We construct a scenario where this happens by forcing a small maxMessages
      const result = pruneConversation(messages, 4);
      // The result should be valid: no assistant with incomplete tool calls at the start of tail
      const tail = result.pruned.filter(m => m.role !== 'system');
      if (tail.length > 0 && tail[0].role === 'assistant' && tail[0].toolCalls && tail[0].toolCalls.length > 0) {
        const toolCallIds = new Set(tail[0].toolCalls.map(tc => tc.id));
        const resultIds = new Set(
          tail.filter(m => m.role === 'tool').map(m => (m as { toolCallId: string }).toolCallId)
        );
        const allPresent = [...toolCallIds].every(id => resultIds.has(id));
        expect(allPresent).toBe(true);
      }
    });
  });

  describe('edge cases', () => {
    it('handles single message conversation', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hi' },
      ];
      const result = pruneConversation(messages, 5);
      expect(result.pruned).toEqual(messages);
      expect(result.warning).toBeUndefined();
    });

    it('handles all system messages', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System 1' },
        { role: 'system', content: 'System 2' },
        { role: 'system', content: 'System 3' },
      ];
      const result = pruneConversation(messages, 5);
      expect(result.pruned).toEqual(messages);
    });

    it('returns a warning string describing the pruning', () => {
      const messages: Message[] = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
      ];
      const result = pruneConversation(messages, 2);
      expect(result.warning).toBeDefined();
      expect(typeof result.warning).toBe('string');
    });
  });
});
