/**
 * Conversation persistence — store and retrieve message histories by session.
 *
 * @module
 */

import type { Message } from '../core/types.js';

/** Interface for persisting conversation message histories. */
export interface ConversationStore {
  /** Save (overwrite) the full message history for a session. */
  save(sessionId: string, messages: readonly Message[]): Promise<void>;
  /** Load the message history for a session (empty array if not found). */
  load(sessionId: string): Promise<Message[]>;
  /**
   * Append a single message to an existing session's history.
   *
   * Note: The in-memory implementation is safe under Node.js single-threaded execution,
   * but custom implementations should ensure atomicity if concurrent appends are possible.
   */
  append(sessionId: string, message: Message): Promise<void>;
  /** Delete a session's history. Returns true if it existed. */
  delete(sessionId: string): Promise<boolean>;
  /** List all session IDs that have stored conversations. */
  list(): Promise<string[]>;
}

/**
 * Create an in-memory ConversationStore.
 *
 * Suitable for development and testing. For production, implement the
 * ConversationStore interface backed by a database or Redis.
 *
 * @example
 * ```ts
 * const store = createInMemoryConversationStore();
 * await store.save('session-1', [{ role: 'user', content: 'Hello' }]);
 * const messages = await store.load('session-1');
 * ```
 */
export function createInMemoryConversationStore(): ConversationStore {
  const store = new Map<string, Message[]>();

  return {
    async save(sessionId, messages) {
      store.set(sessionId, [...messages]);
    },
    async load(sessionId) {
      const messages = store.get(sessionId);
      return messages ? [...messages] : [];
    },
    /** @see ConversationStore.append — safe under single-threaded Node.js; no mutex needed. */
    async append(sessionId, message) {
      const existing = store.get(sessionId) ?? [];
      const messages = [...existing, message];
      store.set(sessionId, messages);
    },
    async delete(sessionId) {
      return store.delete(sessionId);
    },
    async list() {
      return [...store.keys()];
    },
  };
}
