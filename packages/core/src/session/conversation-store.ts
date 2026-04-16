/**
 * Conversation persistence — store and retrieve message histories by session.
 *
 * @module
 */

import type { Message } from '../core/types.js';
import { safeWarn } from '../infra/safe-log.js';

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
/**
 * Declared capabilities of a ConversationStore backend. Callers can gate
 * features (concurrent writes, cross-process replication) on these rather
 * than assuming every implementation upholds the full contract.
 */
export interface ConversationStoreCapabilities {
  /**
   * `append()` is atomic across concurrent callers, including across
   * processes. In-memory (single-process) stores typically set this to
   * `true` by virtue of Node.js single-threaded execution; distributed
   * backends must use an atomic primitive (Redis RPUSH, Postgres
   * `array_append`, row lock).
   */
  readonly atomicAppend?: boolean;
  /** `save()` replaces the full history in a single transaction. */
  readonly atomicSave?: boolean;
  /** `delete()` is atomic and idempotent. */
  readonly atomicDelete?: boolean;
  /** Changes are visible to other processes reading the same backend. */
  readonly distributed?: boolean;
}

export interface ConversationStore {
  /**
   * Declared capabilities. Defaults to all-`false` when omitted. Consumers
   * SHOULD inspect this before relying on atomic-append semantics.
   */
  readonly capabilities?: ConversationStoreCapabilities;

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
 * CQ-011: Configuration for the in-memory conversation store. Defaults
 * remain `Infinity` (backwards compatible), but callers are encouraged to
 * set explicit bounds in production to avoid unbounded growth.
 */
export interface ConversationStoreConfig {
  /** Maximum number of concurrent sessions to retain. Default: Infinity. LRU evicts oldest when exceeded. */
  readonly maxSessions?: number;
  /** Maximum messages retained per session. Default: Infinity. Oldest messages truncated when exceeded. */
  readonly maxMessagesPerSession?: number;
  /**
   * Threshold beyond which a one-time warning is emitted when both limits
   * are `Infinity`. Default: 10_000 sessions.
   */
  readonly unboundedWarnThreshold?: number;
  /** Custom warn sink. Default: structured logger via `safeWarn` (redaction-enabled). */
  readonly onWarning?: (message: string) => void;
}

/**
 * Create an in-memory ConversationStore.
 *
 * Suitable for development and testing. For production, implement the
 * ConversationStore interface backed by a database or Redis.
 *
 * @example
 * ```ts
 * const store = createInMemoryConversationStore({ maxSessions: 1000, maxMessagesPerSession: 500 });
 * await store.save('session-1', [{ role: 'user', content: 'Hello' }]);
 * const messages = await store.load('session-1');
 * ```
 */
export function createInMemoryConversationStore(config?: ConversationStoreConfig): ConversationStore {
  // Map iteration order is insertion order — re-inserting a touched key
  // moves it to the end, giving us LRU semantics cheaply.
  const store = new Map<string, Message[]>();

  const maxSessions = config?.maxSessions ?? Infinity;
  const maxMessagesPerSession = config?.maxMessagesPerSession ?? Infinity;
  const unboundedWarnThreshold = config?.unboundedWarnThreshold ?? 10_000;
  const warn = config?.onWarning ?? ((m: string) => safeWarn(undefined, m));

  let unboundedWarned = false;

  function maybeWarnUnbounded(): void {
    if (unboundedWarned) return;
    if (maxSessions === Infinity && maxMessagesPerSession === Infinity && store.size >= unboundedWarnThreshold) {
      unboundedWarned = true;
      warn(
        `[harness-one/conversation-store] In-memory store now holds ${store.size} sessions with no limits configured. ` +
          `Set maxSessions/maxMessagesPerSession in createInMemoryConversationStore() to bound memory.`,
      );
    }
  }

  function enforceSessionCap(): void {
    if (maxSessions === Infinity) return;
    while (store.size > maxSessions) {
      // LRU: evict the oldest (first-inserted / least-recently-touched) session.
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
    }
  }

  function clampMessages(messages: readonly Message[]): Message[] {
    if (maxMessagesPerSession === Infinity || messages.length <= maxMessagesPerSession) {
      return [...messages];
    }
    // Keep the most recent N messages; truncate oldest.
    return messages.slice(messages.length - maxMessagesPerSession);
  }

  function touch(sessionId: string, messages: Message[]): void {
    // LRU touch: delete+reinsert to move to end-of-iteration.
    store.delete(sessionId);
    store.set(sessionId, messages);
  }

  return {
    capabilities: {
      atomicAppend: true, // single-threaded Node guarantees this in-process
      atomicSave: true,
      atomicDelete: true,
      distributed: false, // in-memory is per-process
    },

    async save(sessionId, messages) {
      const clamped = clampMessages(messages);
      touch(sessionId, clamped);
      enforceSessionCap();
      maybeWarnUnbounded();
    },
    async load(sessionId) {
      const messages = store.get(sessionId);
      return messages ? [...messages] : [];
    },
    /**
     * Append a single message to a session's history.
     *
     * This implementation is safe for single-process access only. For
     * distributed stores, use database-level atomic operations (e.g.,
     * Redis RPUSH, Postgres array_append). Concurrent append from multiple
     * processes without external coordination may lose messages.
     *
     * @see ConversationStore.append -- safe under single-threaded Node.js; no mutex needed.
     */
    async append(sessionId, message) {
      const existing = store.get(sessionId) ?? [];
      const appended = [...existing, message];
      const clamped = clampMessages(appended);
      touch(sessionId, clamped);
      enforceSessionCap();
      maybeWarnUnbounded();
    },
    async delete(sessionId) {
      return store.delete(sessionId);
    },
    async list() {
      return [...store.keys()];
    },
  };
}
