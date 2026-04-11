/**
 * Agent orchestrator — register agents, route messages, delegate tasks.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import { MessageQueue } from './message-queue.js';
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
}

/** Configuration for creating an orchestrator. */
export interface OrchestratorConfig {
  readonly mode?: OrchestrationMode;
  readonly strategy?: DelegationStrategy;
  readonly maxAgents?: number;
  readonly maxQueueSize?: number;
  /** Called when messages are dropped due to queue overflow. */
  readonly onWarning?: (warning: { message: string; droppedCount: number; queueSize: number }) => void;
  /** Called when an event handler throws an exception. If not provided, falls back to console.warn. */
  readonly onHandlerError?: (error: unknown, event: OrchestratorEvent) => void;
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
  const eventHandlers: ((event: OrchestratorEvent) => void)[] = [];
  const contextStore = new Map<string, unknown>();

  // Fix 23: Track delegation chains to detect cycles
  const delegationChain = new Map<string, Set<string>>();

  function emit(event: OrchestratorEvent): void {
    // Iterate over a snapshot so that handlers can safely unsubscribe
    // (or add new handlers) during iteration without mutating the live array.
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
        } else {
          // No onHandlerError configured — silently swallow to avoid console side effects in library code.
          // Users should provide onHandlerError in OrchestratorConfig for production monitoring.
        }
      }
    }
  }

  const mqConfig: {
    maxQueueSize?: number;
    onWarning?: (warning: { message: string; droppedCount: number; queueSize: number }) => void;
    onEvent?: (event: { type: 'message_dropped'; agentId: string; droppedCount: number }) => void;
  } = {
    onEvent: (event) => emit(event),
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
      ...(agent.metadata !== undefined && { metadata: { ...agent.metadata } }),
    };
  }

  function requireAgent(id: string): MutableAgentRegistration {
    const agent = agents.get(id);
    if (!agent) {
      throw new HarnessError(
        `Agent not found: ${id}`,
        'AGENT_NOT_FOUND',
        'Register the agent before performing operations on it',
      );
    }
    return agent;
  }

  const sharedContext: SharedContext = {
    get(key: string): unknown {
      return contextStore.get(key);
    },
    set(key: string, value: unknown): void {
      contextStore.set(key, value);
      emit({ type: 'context_updated', key });
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
          'DUPLICATE_AGENT',
          'Use a unique ID or unregister the existing agent first',
        );
      }
      if (agents.size >= maxAgents) {
        throw new HarnessError(
          `Maximum agents limit reached (${maxAgents})`,
          'MAX_AGENTS',
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
          while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current)) continue;
            visited.add(current);
            // If selectedId can reach delegatedFrom, it's a cycle
            if (current === delegatedFrom) {
              throw new HarnessError(
                `Delegation cycle detected: ${selectedId} is already in the delegation chain of ${delegatedFrom}`,
                'DELEGATION_CYCLE',
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
          delegationChain.get(delegatedFrom)!.add(selectedId);
        }

        emit({ type: 'task_delegated', agentId: selectedId, task });
      }
      return selectedId;
    },

    get context(): SharedContext {
      return sharedContext;
    },

    onEvent(handler: (event: OrchestratorEvent) => void): () => void {
      eventHandlers.push(handler);
      return () => {
        const idx = eventHandlers.indexOf(handler);
        if (idx >= 0) eventHandlers.splice(idx, 1);
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
      eventHandlers.length = 0;
      contextStore.clear();
      delegationChain.clear();
    },
  };

  return orchestrator;
}
