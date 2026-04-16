/**
 * Agent orchestrator — register agents, route messages, delegate tasks.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { MessageQueue } from './message-queue.js';
import { createAsyncLock, type AsyncLock } from '../infra/async-lock.js';
import type { Logger } from '../observe/logger.js';
import type {
  AgentMessage,
  AgentRegistration,
  AgentStatus,
  DelegationStrategy,
  DelegationTask,
  OrchestrationMode,
  OrchestratorEvent,
  SharedContext,
} from './types.js';

/**
 * SEC-011: Keys that would bypass own-property checks via prototype
 * pollution if accidentally used as context keys.
 */
const FORBIDDEN_CONTEXT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * SEC-011: Normalize a key (or policy prefix) via NFKC + casefold so that
 * Unicode visual-variant attacks ("ＡＤＭＩＮ." vs "admin.") cannot bypass
 * prefix-based policies. Exported via the orchestrator internals; callers
 * using `BoundaryPolicy.allowRead/allowWrite` prefixes benefit automatically.
 *
 * Consumers relying on prefix semantics MUST include the literal separator
 * (e.g. `'admin.'`) — we do not silently add it.
 */
export function normalizeContextKey(key: string): string {
  return key.normalize('NFKC').toLowerCase();
}

/** Orchestrator for managing multi-agent coordination. */
export interface AgentOrchestrator {
  /** Register an agent. */
  register(id: string, name: string, options?: { parentId?: string; metadata?: Record<string, unknown> }): AgentRegistration;
  /** Remove an agent. */
  unregister(id: string): boolean;
  /** Get agent by ID. */
  getAgent(id: string): AgentRegistration | undefined;
  /** List all agents, optionally filtered by status or parentId. */
  listAgents(filter?: { status?: AgentStatus; parentId?: string }): AgentRegistration[];
  /** Update agent status. */
  setStatus(id: string, status: AgentStatus): void;
  /** Send a message between agents. */
  send(message: Omit<AgentMessage, 'timestamp'>): void;
  /** Get messages for an agent (inbox). */
  getMessages(agentId: string, options?: { type?: AgentMessage['type']; since?: number }): AgentMessage[];
  /** Broadcast a message to all agents (or children of a parent). */
  broadcast(from: string, content: string, options?: { parentId?: string; metadata?: Record<string, unknown> }): void;
  /** Delegate a task using the configured strategy. Returns the selected agent ID or undefined. */
  delegate(task: DelegationTask): Promise<string | undefined>;
  /** Get the shared context. */
  readonly context: SharedContext;
  /** Subscribe to orchestrator events. Returns unsubscribe function. */
  onEvent(handler: (event: OrchestratorEvent) => void): () => void;
  /** Get children of an agent (hierarchical mode). */
  getChildren(parentId: string): AgentRegistration[];
  /** Dispose the orchestrator, clearing all agents, queues, and handlers. */
  dispose(): void;
  /** Get the orchestration mode. */
  readonly mode: OrchestrationMode;
  /** OBS-009: Runtime metrics snapshot (includes cumulative message drops). */
  getMetrics(): OrchestratorMetrics;
}

/** Configuration for creating an orchestrator. */
export interface OrchestratorConfig {
  readonly mode?: OrchestrationMode;
  readonly strategy?: DelegationStrategy;
  readonly maxAgents?: number;
  readonly maxQueueSize?: number;
  /** Called when messages are dropped due to queue overflow. */
  readonly onWarning?: (warning: { message: string; droppedCount: number; queueSize: number }) => void;
  /** Called when an event handler throws an exception. If not provided, routes to `logger.warn` (or silently swallows when logger also absent). */
  readonly onHandlerError?: (error: unknown, event: OrchestratorEvent) => void;
  /**
   * CQ-028/OBS-009: Optional logger. When set:
   * - Event-handler exceptions without an `onHandlerError` callback route to `logger.warn`.
   * - Queue-overflow message drops always emit `logger.warn` (on top of `onWarning`).
   */
  readonly logger?: Logger;
  /**
   * Optional redaction function applied to agent metadata before it is
   * returned by `getAgent()` / `listAgents()`. Prevents sensitive fields
   * (API keys, tokens, internal state) from leaking to callers.
   *
   * When omitted, metadata is returned as-is (deep-cloned but not filtered).
   */
  readonly redactMetadata?: (metadata: Record<string, unknown>) => Record<string, unknown>;
}

/** OBS-009: Metrics snapshot for an orchestrator instance. */
export interface OrchestratorMetrics {
  /** Cumulative number of messages dropped due to queue overflow. */
  readonly droppedMessages: number;
}

/**
 * Create a new AgentOrchestrator instance.
 *
 * @example
 * ```ts
 * const orch = createOrchestrator({ mode: 'hierarchical', maxAgents: 10 });
 * const agent = orch.register('a1', 'Worker');
 * orch.setStatus('a1', 'running');
 * orch.send({ from: 'a1', to: 'a2', type: 'request', content: 'hello' });
 * ```
 */
export function createOrchestrator(config?: OrchestratorConfig): AgentOrchestrator {
  const mode: OrchestrationMode = config?.mode ?? 'peer';
  const strategy: DelegationStrategy | undefined = config?.strategy;
  const maxAgents = config?.maxAgents ?? Infinity;

  interface MutableAgentRegistration {
    id: string;
    name: string;
    parentId?: string;
    status: AgentStatus;
    metadata?: Record<string, unknown>;
  }

  const agents = new Map<string, MutableAgentRegistration>();
  // PERF-017: Set-backed handler registry for O(1) unsubscribe.
  const eventHandlers = new Set<(event: OrchestratorEvent) => void>();
  const contextStore = new Map<string, unknown>();
  const logger = config?.logger;
  const redactMetadata = config?.redactMetadata;

  // OBS-009: Cumulative count of dropped messages (queue overflow).
  let droppedMessages = 0;

  // Fix 23: Track delegation chains to detect cycles
  const delegationChain = new Map<string, Set<string>>();
  // A1-1 (Wave 4b): per-source-agent async lock. The delegate() flow does
  // "check chain -> await strategy.select() -> mutate chain"; without a lock
  // two concurrent delegations from the same source agent can both pass the
  // cycle check and then both mutate the chain, admitting a cycle that the
  // next caller will observe. Serialise by source agent id so unrelated
  // source agents stay concurrent.
  const delegationLocks = new Map<string, AsyncLock>();
  function getDelegationLock(sourceId: string): AsyncLock {
    let lock = delegationLocks.get(sourceId);
    if (!lock) {
      lock = createAsyncLock();
      delegationLocks.set(sourceId, lock);
    }
    return lock;
  }

  function emit(event: OrchestratorEvent): void {
    // Iterate over a snapshot so that handlers can safely unsubscribe
    // (or add new handlers) during iteration without mutating the live set.
    const snapshot = [...eventHandlers];
    for (const handler of snapshot) {
      try {
        handler(event);
      } catch (err: unknown) {
        // Fix 34: Wrap onHandlerError callback itself in try-catch
        if (config?.onHandlerError) {
          try {
            config.onHandlerError(err, event);
          } catch {
            // Swallow error from error handler to prevent blocking subsequent handlers
          }
        } else if (logger) {
          // CQ-028: Route to injected logger instead of silently swallowing.
          try {
            logger.warn('Orchestrator event handler threw; continuing', {
              error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
              eventType: (event as { type?: string }).type,
            });
          } catch {
            // Logger itself threw — nothing more we can do without recursing.
          }
        }
        // else: No onHandlerError AND no logger — the orchestrator has no
        // sanctioned channel to surface the error. We still don't write to
        // stderr from library code, but the handler is skipped.
      }
    }
  }

  const mqConfig: {
    maxQueueSize?: number;
    onWarning?: (warning: { message: string; droppedCount: number; queueSize: number }) => void;
    onEvent?: (event: { type: 'message_dropped'; agentId: string; droppedCount: number }) => void;
  } = {
    onEvent: (event) => {
      // OBS-009: Track cumulative drops and always signal via logger.
      if (event.type === 'message_dropped') {
        droppedMessages += event.droppedCount;
        if (logger) {
          try {
            logger.warn('Orchestrator message queue dropped message(s) due to overflow', {
              agentId: event.agentId,
              droppedCount: event.droppedCount,
              cumulativeDropped: droppedMessages,
            });
          } catch {
            // Swallow logger exceptions.
          }
        }
      }
      emit(event);
    },
  };
  if (config?.maxQueueSize !== undefined) {
    mqConfig.maxQueueSize = config.maxQueueSize;
  }
  if (config?.onWarning !== undefined) {
    mqConfig.onWarning = config.onWarning;
  }
  const messageQueue = new MessageQueue(mqConfig);

  function toReadonly(agent: MutableAgentRegistration): AgentRegistration {
    return {
      id: agent.id,
      name: agent.name,
      ...(agent.parentId !== undefined && { parentId: agent.parentId }),
      status: agent.status,
      // Deep clone via structuredClone so callers can't mutate nested
      // fields and corrupt orchestrator state. A shallow `{ ...metadata }`
      // leaves nested objects (e.g., `metadata.user`) shared by reference.
      // Optional redaction strips sensitive fields before returning.
      ...(agent.metadata !== undefined && {
        metadata: (() => {
          const cloned = typeof structuredClone === 'function'
            ? structuredClone(agent.metadata)
            : JSON.parse(JSON.stringify(agent.metadata)) as Record<string, unknown>;
          return redactMetadata ? redactMetadata(cloned) : cloned;
        })(),
      }),
    };
  }

  function requireAgent(id: string): MutableAgentRegistration {
    const agent = agents.get(id);
    if (!agent) {
      throw new HarnessError(
        `Agent not found: ${id}`,
        HarnessErrorCode.ORCH_AGENT_NOT_FOUND,
        'Register the agent before performing operations on it',
      );
    }
    return agent;
  }

  const sharedContext: SharedContext = {
    get(key: string): unknown {
      // SEC-011: Normalize key for consistent lookup — ensures 'ADMIN' and
      // 'admin' resolve to the same entry, matching boundary policy normalization.
      return contextStore.get(normalizeContextKey(key));
    },
    /**
     * Set a value on the shared context.
     *
     * SEC-011: Keys that would bypass own-property checks via prototype
     * pollution (`__proto__`, `constructor`, `prototype`) are rejected with
     * an `INVALID_KEY` HarnessError. Keys are normalized via NFKC + casefold
     * before storage so that lookup and boundary policy matching are consistent
     * (see `normalizeContextKey`).
     */
    set(key: string, value: unknown): void {
      if (typeof key !== 'string' || key.length === 0) {
        throw new HarnessError(
          `Invalid context key: keys must be non-empty strings`,
          HarnessErrorCode.CORE_INVALID_KEY,
          'Provide a non-empty string key',
        );
      }
      // SEC-011: Normalize before forbidden-key check to catch Unicode variants.
      const normalized = normalizeContextKey(key);
      if (FORBIDDEN_CONTEXT_KEYS.has(normalized)) {
        throw new HarnessError(
          `Invalid context key "${key}": reserved prototype-polluting identifier`,
          HarnessErrorCode.CORE_INVALID_KEY,
          `Avoid keys in {${Array.from(FORBIDDEN_CONTEXT_KEYS).join(', ')}}`,
        );
      }
      contextStore.set(normalized, value);
      emit({ type: 'context_updated', key: normalized });
    },
    entries(): ReadonlyMap<string, unknown> {
      return new Map(contextStore);
    },
  };

  const orchestrator: AgentOrchestrator = {
    mode,

    register(id: string, name: string, options?: { parentId?: string; metadata?: Record<string, unknown> }): AgentRegistration {
      if (agents.has(id)) {
        throw new HarnessError(
          `Agent already registered: ${id}`,
          HarnessErrorCode.ORCH_DUPLICATE_AGENT,
          'Use a unique ID or unregister the existing agent first',
        );
      }
      if (agents.size >= maxAgents) {
        throw new HarnessError(
          `Maximum agents limit reached (${maxAgents})`,
          HarnessErrorCode.ORCH_MAX_AGENTS,
          'Increase maxAgents or unregister unused agents',
        );
      }
      if (options?.parentId !== undefined) {
        requireAgent(options.parentId);
      }
      const agent: MutableAgentRegistration = {
        id,
        name,
        ...(options?.parentId !== undefined && { parentId: options.parentId }),
        status: 'idle',
        ...(options?.metadata !== undefined && { metadata: { ...options.metadata } }),
      };
      agents.set(id, agent);
      messageQueue.createQueue(id);
      const registration = toReadonly(agent);
      emit({ type: 'agent_registered', agent: registration });
      return registration;
    },

    unregister(id: string): boolean {
      const existed = agents.delete(id);
      if (existed) {
        messageQueue.deleteQueue(id);
        // Fix 23: Clean up delegation chain
        delegationChain.delete(id);
        for (const chain of delegationChain.values()) {
          chain.delete(id);
        }
        // A1-1 (Wave 4b): drop the delegation lock for this source agent.
        // Waiters (if any) are implausible since the caller would need to
        // still hold a reference, and the lock is empty once the final
        // critical section returns.
        delegationLocks.delete(id);
      }
      return existed;
    },

    getAgent(id: string): AgentRegistration | undefined {
      const agent = agents.get(id);
      if (!agent) return undefined;
      return toReadonly(agent);
    },

    listAgents(filter?: { status?: AgentStatus; parentId?: string }): AgentRegistration[] {
      const result: AgentRegistration[] = [];
      for (const agent of agents.values()) {
        if (filter?.status !== undefined && agent.status !== filter.status) continue;
        if (filter?.parentId !== undefined && agent.parentId !== filter.parentId) continue;
        result.push(toReadonly(agent));
      }
      return result;
    },

    setStatus(id: string, status: AgentStatus): void {
      const agent = requireAgent(id);
      const from = agent.status;
      agent.status = status;
      emit({ type: 'agent_status_changed', agentId: id, from, to: status });
    },

    send(message: Omit<AgentMessage, 'timestamp'>): void {
      requireAgent(message.from);
      requireAgent(message.to);
      const fullMessage: AgentMessage = {
        ...message,
        timestamp: Date.now(),
      };
      const accepted = messageQueue.push(message.to, fullMessage);
      if (accepted) {
        emit({ type: 'message_sent', message: fullMessage });
      }
    },

    getMessages(agentId: string, options?: { type?: AgentMessage['type']; since?: number }): AgentMessage[] {
      return messageQueue.getMessages(agentId, options);
    },

    broadcast(from: string, content: string, options?: { parentId?: string; metadata?: Record<string, unknown> }): void {
      requireAgent(from);
      const targets: MutableAgentRegistration[] = [];
      for (const agent of agents.values()) {
        if (agent.id === from) continue;
        if (options?.parentId !== undefined && agent.parentId !== options.parentId) continue;
        targets.push(agent);
      }
      for (const target of targets) {
        const message: AgentMessage = {
          from,
          to: target.id,
          type: 'broadcast',
          content,
          ...(options?.metadata !== undefined && { metadata: { ...options.metadata } }),
          timestamp: Date.now(),
        };
        const accepted = messageQueue.push(target.id, message);
        if (accepted) {
          emit({ type: 'message_sent', message });
        }
      }
    },

    async delegate(task: DelegationTask): Promise<string | undefined> {
      if (!strategy) return undefined;
      // A1-1 (Wave 4b): the cycle-detection window ("inspect delegationChain
      // -> await strategy.select -> mutate delegationChain") is a TOCTOU gap
      // when two delegations originate from the same source agent. Take a
      // per-source-agent lock so only one inspection+mutation runs at a time.
      // When there's no `delegatedFrom`, there is nothing to cycle-check
      // against, so we fall back to an unlocked path (strategy.select is
      // stateless w.r.t. delegationChain).
      const delegatedFromKey = task.metadata?.delegatedFrom as string | undefined;
      const runDelegation = async (): Promise<string | undefined> => {
        const allAgents = Array.from(agents.values()).map(toReadonly);
        const selectedId = await strategy.select(allAgents, task);
        if (selectedId !== undefined) {
          // Fix 23: Check for delegation cycles
          // If task has metadata with delegatedFrom, check chain
          const delegatedFrom = task.metadata?.delegatedFrom as string | undefined;
          if (delegatedFrom && selectedId) {
            // Check: has selectedId ever (directly or transitively) delegated
            // to delegatedFrom? If so, delegating from delegatedFrom back to
            // selectedId would create a cycle.
            const visited = new Set<string>();
            const queue = [selectedId];
            let queueIdx = 0;
            while (queueIdx < queue.length) {
              const current = queue[queueIdx++];
              if (visited.has(current)) continue;
              visited.add(current);
              // If selectedId can reach delegatedFrom, it's a cycle
              if (current === delegatedFrom) {
                throw new HarnessError(
                  `Delegation cycle detected: ${selectedId} is already in the delegation chain of ${delegatedFrom}`,
                  HarnessErrorCode.ORCH_DELEGATION_CYCLE,
                  'Avoid delegating tasks back to agents that originated the delegation',
                );
              }
              // Check who 'current' has delegated to
              const delegates = delegationChain.get(current);
              if (delegates) {
                for (const d of delegates) {
                  if (!visited.has(d)) queue.push(d);
                }
              }
            }

            // Record the delegation: delegatedFrom -> selectedId
            if (!delegationChain.has(delegatedFrom)) {
              delegationChain.set(delegatedFrom, new Set());
            }
            (delegationChain.get(delegatedFrom) as Set<string>).add(selectedId);
          }

          emit({ type: 'task_delegated', agentId: selectedId, task });
        }
        return selectedId;
      };
      if (delegatedFromKey) {
        return getDelegationLock(delegatedFromKey).withLock(runDelegation);
      }
      return runDelegation();
    },

    get context(): SharedContext {
      return sharedContext;
    },

    // PERF-017: Set-backed eventHandlers; add/delete are O(1) and we iterate
    // via spread in `emit()` so handlers can subscribe/unsubscribe safely.
    onEvent(handler: (event: OrchestratorEvent) => void): () => void {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },

    getChildren(parentId: string): AgentRegistration[] {
      const result: AgentRegistration[] = [];
      for (const agent of agents.values()) {
        if (agent.parentId === parentId) {
          result.push(toReadonly(agent));
        }
      }
      return result;
    },

    dispose(): void {
      agents.clear();
      messageQueue.clear();
      eventHandlers.clear();
      contextStore.clear();
      delegationChain.clear();
      delegationLocks.clear();
      droppedMessages = 0;
    },

    getMetrics(): OrchestratorMetrics {
      return { droppedMessages };
    },
  };

  return orchestrator;
}
