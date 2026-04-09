/**
 * Conversation persistence — store and retrieve message histories by session.
 *
 * @module
 */

import type { Message } from '../core/types.js';

/**
 * Interface for persisting conversation message histories.
 *
 * ## Production Implementation Guide
 *
 * When implementing a production `ConversationStore` backed by a database or Redis,
 * ensure the following guarantees:
 *
 * **Atomicity requirements:**
 * - `save()` must atomically replace the entire message history for a session.
 *   Use a transaction or atomic write to avoid partial updates.
 * - `append()` must atomically add a message to the existing history.
 *   Use a database-level append (e.g., `RPUSH` in Redis, `array_append` in Postgres)
 *   or a compare-and-swap mechanism to prevent lost writes under concurrent access.
 * - `delete()` must atomically remove the session history and return whether it existed.
 *
 * **Consistency guarantees:**
 * - After `save()` resolves, a subsequent `load()` must return the saved messages.
 * - After `append()` resolves, a subsequent `load()` must include the appended message.
 * - After `delete()` resolves, a subsequent `load()` must return an empty array.
 * - `list()` must reflect all sessions that have been saved or appended to but not deleted.
 *
 * **Error handling:**
 * - All methods return Promises and should reject with descriptive errors on failure
 *   (e.g., network errors, serialization errors).
 * - Implementations should NOT silently swallow errors.
 *
 * **Defensive copying:**
 * - `load()` should return a fresh copy of the data so callers cannot corrupt the store.
 * - `save()` should copy the input so later mutations to the caller's array are not reflected.
 */
export interface ConversationStore {
  /**
   * Save (overwrite) the full message history for a session.
   * Must be atomic: either the full history is replaced or the operation fails.
   */
  save(sessionId: string, messages: readonly Message[]): Promise<void>;
  /** Load the message history for a session (empty array if not found). */
  load(sessionId: string): Promise<Message[]>;
  /**
   * Append a single message to an existing session's history.
   *
   * Must be atomic under concurrent access. The in-memory implementation is
   * safe under Node.js single-threaded execution, but production implementations
   * backed by a database should use a database-level atomic append operation
   * (e.g., Redis RPUSH, Postgres array_append, or a row-level lock).
   */
  append(sessionId: string, message: Message): Promise<void>;
  /**
   * Delete a session's history. Returns true if it existed.
   * Must be atomic: the history is fully removed or the operation fails.
   */
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
