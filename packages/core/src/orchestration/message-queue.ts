/**
 * Message queue management for agent orchestration.
 *
 * Provides per-agent bounded message queues with drop-oldest overflow policy,
 * backpressure signaling via callbacks and events.
 *
 * @module
 */

import type { AgentMessage } from './types.js';

/** Callback for when messages are dropped due to queue overflow. */
export interface QueueWarningHandler {
  (warning: { message: string; droppedCount: number; queueSize: number }): void;
}

/** Callback for emitting observable events (e.g., message_dropped). */
export interface QueueEventEmitter {
  (event: { type: 'message_dropped'; agentId: string; droppedCount: number }): void;
}

/** Configuration for the MessageQueue. */
export interface MessageQueueConfig {
  readonly maxQueueSize?: number;
  readonly onWarning?: QueueWarningHandler;
  readonly onEvent?: QueueEventEmitter;
}

/**
 * Per-agent message queue manager.
 *
 * Handles bounded queue enforcement with drop-oldest overflow policy:
 * when a queue is full, the oldest message is removed to make room for the new one.
 */
export class MessageQueue {
  private readonly queues = new Map<string, AgentMessage[]>();
  private readonly maxQueueSize: number;
  private readonly onWarning: QueueWarningHandler | undefined;
  private readonly onEvent: QueueEventEmitter | undefined;

  constructor(config?: MessageQueueConfig) {
    this.maxQueueSize = config?.maxQueueSize ?? 1000;
    this.onWarning = config?.onWarning;
    this.onEvent = config?.onEvent;
  }

  /** Create a queue for an agent. */
  createQueue(agentId: string): void {
    this.queues.set(agentId, []);
  }

  /** Delete an agent's queue. */
  deleteQueue(agentId: string): boolean {
    return this.queues.delete(agentId);
  }

  /** Check if an agent has a queue. */
  hasQueue(agentId: string): boolean {
    return this.queues.has(agentId);
  }

  /**
   * Push a message to an agent's queue. Returns true if accepted.
   *
   * When the queue is at capacity, the oldest message is dropped to make room,
   * and a warning/event is emitted for backpressure signaling.
   *
   * Thread-safety note: The check-then-modify pattern below (read queue.length,
   * then shift + push) is safe because JavaScript is single-threaded and this
   * method is synchronous — no other code can interleave between the length
   * check and the mutation. If this method were ever made async (e.g., to await
   * a persistent store), the check+modify would need to be wrapped in a mutex
   * or atomic compare-and-swap to prevent concurrent pushes from exceeding
   * maxQueueSize.
   */
  push(agentId: string, message: AgentMessage): boolean {
    const queue = this.queues.get(agentId);
    if (!queue) return false;

    if (queue.length >= this.maxQueueSize) {
      // Drop oldest to make room (drop-oldest overflow policy)
      const droppedCount = 1;
      queue.shift();

      const warning = {
        message: `Dropped ${droppedCount} message(s) from queue for agent "${agentId}" (maxQueueSize: ${this.maxQueueSize})`,
        droppedCount,
        queueSize: this.maxQueueSize,
      };
      if (this.onWarning) {
        this.onWarning(warning);
      }
      // Emit observable event so monitoring systems can alert on queue saturation
      if (this.onEvent) {
        this.onEvent({ type: 'message_dropped', agentId, droppedCount });
      }
    }

    queue.push(message);
    return true;
  }

  /**
   * Get messages for an agent, with optional filtering.
   */
  getMessages(agentId: string, options?: { type?: AgentMessage['type']; since?: number }): AgentMessage[] {
    const queue = this.queues.get(agentId);
    if (!queue) return [];
    let messages: AgentMessage[] = queue;
    if (options?.type !== undefined) {
      messages = messages.filter((m) => m.type === options.type);
    }
    if (options?.since !== undefined) {
      messages = messages.filter((m) => m.timestamp >= options.since!);
    }
    return messages;
  }

  /** Clear all queues. */
  clear(): void {
    this.queues.clear();
  }
}
