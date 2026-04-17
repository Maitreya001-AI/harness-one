/**
 * Agent orchestrator — register agents, route messages, delegate tasks.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { MessageQueue } from './message-queue.js';
import type { Logger } from '../infra/logger.js';
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
import { createSharedContext } from './shared-context-store.js';
import { createDelegationTracker } from './delegation-tracker.js';

// Re-export so existing consumers (context-boundary + external callers) see
// the canonical symbol at its original path.
export { normalizeContextKey, FORBIDDEN_CONTEXT_KEYS } from './shared-context-store.js';

// ──────────────────────────────────────────────────────────────────────────
// Facet interfaces — narrow contracts that `AgentOrchestrator` composes.
//
// Consumers that only need one concern (e.g. a component that just reads
// the registry) can accept the minimal facet rather than the full
// orchestrator. The facets are *purely* a type-level slicing; the
// runtime impl still satisfies all of them via the composite interface
// below.
// ──────────────────────────────────────────────────────────────────────────

/** CRUD over the agent registration table. */
export interface AgentRegistry {
  /** Register an agent. */
  register(
    id: string,
    name: string,
    options?: { parentId?: string; metadata?: Record<string, unknown> },
  ): AgentRegistration;
  /** Remove an agent. */
  unregister(id: string): boolean;
  /** Get agent by ID. */
  getAgent(id: string): AgentRegistration | undefined;
  /** List all agents, optionally filtered by status or parentId. */
  listAgents(filter?: { status?: AgentStatus; parentId?: string }): AgentRegistration[];
  /** Update agent status. */
  setStatus(id: string, status: AgentStatus): void;
  /** Get children of an agent (hierarchical mode). */
  getChildren(parentId: string): AgentRegistration[];
}

/** Agent-to-agent messaging (inbox + broadcast). */
export interface AgentMessageBus {
  /** Send a message between agents. */
  send(message: Omit<AgentMessage, 'timestamp'>): void;
  /** Get messages for an agent (inbox). */
  getMessages(
    agentId: string,
    options?: { type?: AgentMessage['type']; since?: number },
  ): AgentMessage[];
  /** Broadcast a message to all agents (or children of a parent). */
  broadcast(
    from: string,
    content: string,
    options?: { parentId?: string; metadata?: Record<string, unknown> },
  ): void;
}

/** Task delegation + orchestration mode introspection. */
export interface AgentDelegator {
  /** Delegate a task using the configured strategy. Returns the selected agent ID or undefined. */
  delegate(task: DelegationTask): Promise<string | undefined>;
  /** Get the orchestration mode. */
  readonly mode: OrchestrationMode;
}

/** Lifecycle, shared state, and observability hooks on the orchestrator. */
export interface OrchestratorLifecycle {
  /** Get the shared context. */
  readonly context: SharedContext;
  /** Subscribe to orchestrator events. Returns unsubscribe function. */
  onEvent(handler: (event: OrchestratorEvent) => void): () => void;
  /** Dispose the orchestrator, clearing all agents, queues, and handlers. */
  dispose(): void;
  /** Dispose the orchestrator after waiting for in-flight delegations. */
  drainAndDispose(timeoutMs?: number): Promise<void>;
  /** Runtime metrics snapshot (includes cumulative message drops). */
  getMetrics(): OrchestratorMetrics;
}

/**
 * Orchestrator for managing multi-agent coordination. Composes the four
 * narrower facets — consumers that only need a subset should accept that
 * specific facet (e.g. `AgentRegistry`) rather than the full interface.
 */
export interface AgentOrchestrator
  extends AgentRegistry,
    AgentMessageBus,
    AgentDelegator,
    OrchestratorLifecycle {}

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
   * Optional logger. When set:
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
  /**
   * Cap on total delegation-chain entries (cumulative size of all inner Sets
   * across all delegators). Prevents a stuck orchestrator from growing
   * `delegationChain` without bound when delegations never settle into
   * unregistration. Default: 10_000. Breaches throw
   * {@link HarnessErrorCode.ORCH_DELEGATION_LIMIT}.
   */
  readonly maxDelegationChainEntries?: number;
  /**
   * Cap on shared-context store entries. Prevents unbounded growth of
   * `sharedContext.set()` writes in long-running orchestrators. Default:
   * 10_000. Breaches throw {@link HarnessErrorCode.ORCH_CONTEXT_LIMIT} with
   * a remediation hint.
   */
  readonly maxSharedContextEntries?: number;
}

/** Metrics snapshot for an orchestrator instance. */
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
  const maxDelegationChainEntries = config?.maxDelegationChainEntries ?? 10_000;
  const maxSharedContextEntries = config?.maxSharedContextEntries ?? 10_000;

  interface MutableAgentRegistration {
    id: string;
    name: string;
    parentId?: string;
    status: AgentStatus;
    metadata?: Record<string, unknown>;
  }

  let inflightDelegations = 0;
  let disposed = false;

  const agents = new Map<string, MutableAgentRegistration>();
  // Set-backed handler registry for O(1) unsubscribe.
  const eventHandlers = new Set<(event: OrchestratorEvent) => void>();
  const logger = config?.logger;
  const redactMetadata = config?.redactMetadata;

  // Cumulative count of dropped messages (queue overflow).
  let droppedMessages = 0;

  const delegationTracker = createDelegationTracker({
    maxEntries: maxDelegationChainEntries,
  });

  function emit(event: OrchestratorEvent): void {
    // Iterate over a snapshot so that handlers can safely unsubscribe
    // (or add new handlers) during iteration without mutating the live set.
    const snapshot = [...eventHandlers];
    for (const handler of snapshot) {
      try {
        handler(event);
      } catch (err: unknown) {
        // Wrap onHandlerError callback itself in try-catch.
        if (config?.onHandlerError) {
          try {
            config.onHandlerError(err, event);
          } catch {
            // Swallow error from error handler to prevent blocking subsequent handlers
          }
        } else if (logger) {
          // Route to injected logger instead of silently swallowing.
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
      // Track cumulative drops and always signal via logger.
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
      // `package.json` pins node>=18, so `structuredClone` is always present.
      ...(agent.metadata !== undefined && {
        metadata: (() => {
          const cloned = structuredClone(agent.metadata);
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

  const sharedContextStore = createSharedContext({
    maxEntries: maxSharedContextEntries,
    emit: (event) => emit(event),
  });
  const sharedContext: SharedContext = sharedContextStore.context;

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
        delegationTracker.removeAgent(id);
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
      if (disposed) {
        throw new HarnessError(
          'Orchestrator is disposing, cannot accept new delegations',
          HarnessErrorCode.CORE_INVALID_STATE,
          'Wait for drainAndDispose() to complete',
        );
      }
      if (!strategy) return undefined;
      // The cycle-detection window ("inspect delegationChain -> await
      // strategy.select -> mutate delegationChain") is a TOCTOU gap when
      // two delegations originate from the same source agent. Take a
      // per-source-agent lock so only one inspection+mutation runs at a
      // time. When there's no `delegatedFrom`, there is nothing to
      // cycle-check against, so we fall back to an unlocked path
      // (strategy.select is stateless w.r.t. delegationChain).
      const delegatedFromKey = task.metadata?.delegatedFrom as string | undefined;
      const runDelegation = async (): Promise<string | undefined> => {
        const allAgents = Array.from(agents.values()).map(toReadonly);
        const selectedId = await strategy.select(allAgents, task);
        if (selectedId !== undefined) {
          // Cycle + size-cap bookkeeping lives in the delegation tracker.
          const delegatedFrom = task.metadata?.delegatedFrom as string | undefined;
          if (delegatedFrom && selectedId) {
            delegationTracker.assertNoCycle(delegatedFrom, selectedId);
            delegationTracker.recordEdge(delegatedFrom, selectedId);
          }

          emit({ type: 'task_delegated', agentId: selectedId, task });
        }
        return selectedId;
      };
      const trackedDelegation = async (): Promise<string | undefined> => {
        inflightDelegations++;
        try {
          return await runDelegation();
        } finally {
          inflightDelegations--;
        }
      };
      if (delegatedFromKey) {
        return delegationTracker.getLock(delegatedFromKey).withLock(trackedDelegation);
      }
      return trackedDelegation();
    },

    get context(): SharedContext {
      return sharedContext;
    },

    // Set-backed eventHandlers; add/delete are O(1) and we iterate via spread
    // in `emit()` so handlers can subscribe/unsubscribe safely.
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
      sharedContextStore.dispose();
      delegationTracker.clear();
      droppedMessages = 0;
    },

    async drainAndDispose(timeoutMs: number = 30_000): Promise<void> {
      disposed = true;
      // Wait for in-flight delegations to complete
      const deadline = Date.now() + timeoutMs;
      while (inflightDelegations > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      orchestrator.dispose();
    },

    getMetrics(): OrchestratorMetrics {
      return { droppedMessages };
    },
  };

  return orchestrator;
}
