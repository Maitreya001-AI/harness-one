/**
 * Message queue management for agent orchestration.
 *
 * Provides per-agent bounded message queues with configurable overflow policy:
 * - Default (backpressure=false): drop-oldest overflow policy with backpressure
 *   signaling via callbacks and events.
 * - Backpressure mode (backpressure=true): reject the send with HarnessErrorCode.ORCH_QUEUE_FULL
 *   error, letting the sender decide whether to retry or buffer.
 *
 * Message ordering is FIFO per sender-receiver pair within a single process.
 * No ordering guarantees across processes or network boundaries. For total
 * ordering in distributed systems, use Lamport clocks or a centralized
 * message broker.
 *
 * Construction: use {@link createMessageQueue}. The implementing class is
 * deliberately private per the factories-not-classes rule in
 * `docs/ARCHITECTURE.md` §Construction; the published surface is the
 * {@link MessageQueue} interface + the factory.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';
import type { Logger } from '../infra/logger.js';
import type { MetricCounter, MetricGauge, MetricsPort } from '../core/metrics-port.js';
import type { AgentMessage } from './types.js';

/** Callback for when messages are dropped due to queue overflow. */
export interface QueueWarningHandler {
  (warning: { message: string; droppedCount: number; queueSize: number }): void;
}

/** Callback for emitting observable events (e.g., message_dropped). */
export interface QueueEventEmitter {
  (event: { type: 'message_dropped'; agentId: string; droppedCount: number }): void;
}

/** Configuration for the MessageQueue factory. */
export interface MessageQueueConfig {
  readonly maxQueueSize?: number;
  readonly onWarning?: QueueWarningHandler;
  readonly onEvent?: QueueEventEmitter;
  /**
   * When `true`, reject sends with `HarnessErrorCode.ORCH_QUEUE_FULL` instead
   * of dropping the oldest message. The sender can then decide to retry or
   * buffer. Default: `false` (drop-oldest).
   */
  readonly backpressure?: boolean;
  /**
   * Optional structured logger. When set, every queue-overflow drop emits a
   * `warn` in addition to any user-supplied `onWarning`. When omitted,
   * nothing is logged (no allocation).
   */
  readonly logger?: Logger;
  /**
   * MetricsPort for queue observability. When set, two instruments are emitted:
   *  - `harness.orch.queue_depth` (gauge) — observed on every push,
   *    labelled with `agent_id`.
   *  - `harness.orch.queue_dropped` (counter) — incremented on every drop,
   *    labelled with `agent_id`.
   */
  readonly metrics?: MetricsPort;
}

/**
 * Per-agent message queue manager.
 *
 * Handles bounded queue enforcement with configurable overflow policy.
 *
 * **Ordering guarantees**: Message ordering is FIFO per sender-receiver
 * pair within a single process. No ordering guarantees across processes or
 * network boundaries. For total ordering in distributed systems, use Lamport
 * clocks or a centralized message broker.
 */
export interface MessageQueue {
  /** Create a queue for an agent. */
  createQueue(agentId: string): void;
  /** Delete an agent's queue. Returns `true` iff it existed. */
  deleteQueue(agentId: string): boolean;
  /** Check if an agent has a queue. */
  hasQueue(agentId: string): boolean;
  /**
   * Push a message to an agent's queue. Returns `true` if accepted,
   * `false` when the agent has no queue.
   *
   * When the queue is at capacity:
   * - **backpressure=false** (default): drops the oldest message and emits
   *   warning + event + metric.
   * - **backpressure=true**: throws `HarnessError(ORCH_QUEUE_FULL)`.
   */
  push(agentId: string, message: AgentMessage): boolean;
  /**
   * Get messages for an agent, with optional filtering.
   *
   * `since` uses strict `>` semantics so tail-style loops that pass the
   * last-seen timestamp do not receive the boundary message twice.
   *
   * **Allocates a new array on every call.** For hot paths, prefer
   * {@link iterateMessages}.
   */
  getMessages(
    agentId: string,
    options?: { type?: AgentMessage['type']; since?: number },
  ): AgentMessage[];
  /**
   * Zero-copy iterator over messages matching the filter. Captures the queue
   * length at iteration start so mid-iteration pushes don't affect the
   * snapshot; yielded references are the live message objects stored in the
   * queue — don't mutate them unless you own the producer.
   */
  iterateMessages(
    agentId: string,
    options?: { type?: AgentMessage['type']; since?: number },
  ): Generator<AgentMessage, void, void>;
  /** First matching message without copying, or `undefined`. */
  peekMessages(
    agentId: string,
    options?: { type?: AgentMessage['type']; since?: number },
  ): AgentMessage | undefined;
  /**
   * Remove and return up to `limit` messages (FIFO). Omit `limit` to drain
   * the full queue.
   */
  dequeue(agentId: string, limit?: number): AgentMessage[];
  /**
   * Read-only copy of (up to `limit`) messages without removing them.
   */
  peek(agentId: string, limit?: number): AgentMessage[];
  /** Current size of an agent's queue. */
  size(agentId: string): number;
  /** Clear all queues on the manager. */
  clear(): void;
}

/**
 * Create a per-agent bounded message queue manager.
 *
 * @example
 * ```ts
 * const queue = createMessageQueue({ maxQueueSize: 100, backpressure: true });
 * queue.createQueue('agent-a');
 * queue.push('agent-a', { from: 'user', to: 'agent-a', content: 'hi', type: 'message', timestamp: Date.now() });
 * ```
 */
export function createMessageQueue(config?: MessageQueueConfig): MessageQueue {
  const queues = new Map<string, AgentMessage[]>();
  const maxQueueSize = config?.maxQueueSize ?? 1000;
  if (maxQueueSize < 1) {
    throw new HarnessError(
      'maxQueueSize must be >= 1',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive maxQueueSize value',
    );
  }
  const onWarning = config?.onWarning;
  const onEvent = config?.onEvent;
  const backpressure = config?.backpressure ?? false;
  const logger: Logger | undefined = config?.logger;
  // Resolve metric instruments once so the hot `push()` path avoids per-call
  // lookups. A no-op `MetricsPort` returns `undefined` from `gauge`/`counter`;
  // optional-chain calls turn into no-ops with zero allocation.
  const depthGauge: MetricGauge | undefined = config?.metrics?.gauge(
    'harness.orch.queue_depth',
    {
      description: 'Current depth of a per-agent message queue',
      unit: '1',
    },
  );
  const dropCounter: MetricCounter | undefined = config?.metrics?.counter(
    'harness.orch.queue_dropped',
    {
      description:
        'Count of messages dropped due to queue overflow, keyed by agent_id',
    },
  );

  return {
    createQueue(agentId) {
      queues.set(agentId, []);
    },

    deleteQueue(agentId) {
      return queues.delete(agentId);
    },

    hasQueue(agentId) {
      return queues.has(agentId);
    },

    push(agentId, message) {
      const queue = queues.get(agentId);
      if (!queue) return false;

      if (queue.length >= maxQueueSize) {
        if (backpressure) {
          throw new HarnessError(
            `Queue full for agent "${agentId}" (maxQueueSize: ${maxQueueSize})`,
            HarnessErrorCode.ORCH_QUEUE_FULL,
            'Wait for messages to be consumed or increase maxQueueSize',
          );
        }

        const droppedCount = 1;
        queue.shift();

        const warning = {
          message: `Dropped ${droppedCount} message(s) from queue for agent "${agentId}" (maxQueueSize: ${maxQueueSize})`,
          droppedCount,
          queueSize: maxQueueSize,
        };
        if (onWarning) onWarning(warning);
        if (onEvent) onEvent({ type: 'message_dropped', agentId, droppedCount });
        dropCounter?.add(droppedCount, { agent_id: agentId });
        if (logger) {
          try {
            logger.warn('message-queue drop', {
              agent_id: agentId,
              dropped_count: droppedCount,
              max_queue_size: maxQueueSize,
            });
          } catch {
            // Logger threw — swallow; drop path must not fail.
          }
        }
      }

      queue.push(message);

      // Depth gauge is emitted AFTER the push so the reported depth matches
      // the post-mutation queue length.
      depthGauge?.record(queue.length, { agent_id: agentId });

      return true;
    },

    getMessages(agentId, options) {
      const queue = queues.get(agentId);
      if (!queue) return [];
      if (
        options === undefined ||
        (options.type === undefined && options.since === undefined)
      ) {
        return queue.slice();
      }
      const result: AgentMessage[] = [];
      const typeFilter = options.type;
      const sinceFilter = options.since;
      for (let i = 0; i < queue.length; i++) {
        const m = queue[i];
        if (typeFilter !== undefined && m.type !== typeFilter) continue;
        if (sinceFilter !== undefined && !(m.timestamp > sinceFilter)) continue;
        result.push(m);
      }
      return result;
    },

    *iterateMessages(agentId, options) {
      const queue = queues.get(agentId);
      if (!queue) return;
      const typeFilter = options?.type;
      const sinceFilter = options?.since;
      const snapshotLen = queue.length;
      for (let i = 0; i < snapshotLen; i++) {
        const m = queue[i];
        if (m === undefined) continue;
        if (typeFilter !== undefined && m.type !== typeFilter) continue;
        if (sinceFilter !== undefined && !(m.timestamp > sinceFilter)) continue;
        yield m;
      }
    },

    peekMessages(agentId, options) {
      const queue = queues.get(agentId);
      if (!queue) return undefined;
      const typeFilter = options?.type;
      const sinceFilter = options?.since;
      const snapshotLen = queue.length;
      for (let i = 0; i < snapshotLen; i++) {
        const m = queue[i];
        if (m === undefined) continue;
        if (typeFilter !== undefined && m.type !== typeFilter) continue;
        if (sinceFilter !== undefined && !(m.timestamp > sinceFilter)) continue;
        return m;
      }
      return undefined;
    },

    dequeue(agentId, limit) {
      const queue = queues.get(agentId);
      if (!queue || queue.length === 0) return [];
      const count =
        limit !== undefined
          ? Math.min(Math.max(0, limit), queue.length)
          : queue.length;
      if (count === 0) return [];
      return queue.splice(0, count);
    },

    peek(agentId, limit) {
      const queue = queues.get(agentId);
      if (!queue) return [];
      if (limit !== undefined) return queue.slice(0, limit);
      return [...queue];
    },

    size(agentId) {
      return queues.get(agentId)?.length ?? 0;
    },

    clear() {
      queues.clear();
    },
  };
}
