/**
 * Agent orchestrator — register agents, route messages, delegate tasks.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
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
  /** Get the orchestration mode. */
  readonly mode: OrchestrationMode;
}

/** Configuration for creating an orchestrator. */
export interface OrchestratorConfig {
  readonly mode?: OrchestrationMode;
  readonly strategy?: DelegationStrategy;
  readonly maxAgents?: number;
  readonly maxQueueSize?: number;
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
  const messageQueues = new Map<string, AgentMessage[]>();
  const eventHandlers: ((event: OrchestratorEvent) => void)[] = [];
  const contextStore = new Map<string, unknown>();

  function emit(event: OrchestratorEvent): void {
    for (const handler of eventHandlers) {
      try {
        handler(event);
      } catch {
        // Prevent misbehaving handler from breaking event delivery
      }
    }
  }

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

  function pushToQueue(agentId: string, message: AgentMessage): void {
    const queue = messageQueues.get(agentId);
    if (queue) {
      queue.push(message);
      const maxQueueSize = config?.maxQueueSize ?? 1000;
      if (queue.length > maxQueueSize) {
        queue.splice(0, queue.length - maxQueueSize);
      }
    }
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
      messageQueues.set(id, []);
      const registration = toReadonly(agent);
      emit({ type: 'agent_registered', agent: registration });
      return registration;
    },

    unregister(id: string): boolean {
      const existed = agents.delete(id);
      if (existed) {
        messageQueues.delete(id);
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
      pushToQueue(message.to, fullMessage);
      emit({ type: 'message_sent', message: fullMessage });
    },

    getMessages(agentId: string, options?: { type?: AgentMessage['type']; since?: number }): AgentMessage[] {
      const queue = messageQueues.get(agentId);
      if (!queue) return [];
      let messages = queue;
      if (options?.type !== undefined) {
        messages = messages.filter((m) => m.type === options.type);
      }
      if (options?.since !== undefined) {
        messages = messages.filter((m) => m.timestamp >= options.since!);
      }
      return messages;
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
        pushToQueue(target.id, message);
        emit({ type: 'message_sent', message });
      }
    },

    async delegate(task: DelegationTask): Promise<string | undefined> {
      if (!strategy) return undefined;
      const allAgents = Array.from(agents.values()).map(toReadonly);
      const selectedId = await strategy.select(allAgents, task);
      if (selectedId !== undefined) {
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
  };

  return orchestrator;
}
