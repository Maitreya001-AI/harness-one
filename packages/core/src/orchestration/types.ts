/**
 * Type definitions for the orchestration module.
 *
 * @module
 */

import type { AgentAdapter, Message, TokenUsage, ToolCallRequest, ToolSchema } from '../core/types.js';
import type { DoneReason } from '../core/events.js';

/** Configuration for spawning a sub-agent. */
export interface SpawnSubAgentConfig {
  readonly adapter: AgentAdapter;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly maxIterations?: number;
  readonly maxTotalTokens?: number;
  readonly signal?: AbortSignal;
  readonly streaming?: boolean;
}

/** Result returned by a completed sub-agent. */
export interface SpawnSubAgentResult {
  readonly messages: readonly Message[];
  readonly usage: TokenUsage;
  readonly doneReason: DoneReason;
}

/** Status of an agent in the orchestrator. */
export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed';

/** Mode of orchestration. */
export type OrchestrationMode = 'hierarchical' | 'peer';

/** A message passed between agents. */
export interface AgentMessage {
  readonly from: string;
  readonly to: string;
  readonly type: 'request' | 'response' | 'broadcast';
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp: number;
}

/** Registration info for an agent in the orchestrator. */
export interface AgentRegistration {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly status: AgentStatus;
  readonly metadata?: Record<string, unknown>;
  /** Optional session identifier for per-agent session routing. */
  readonly sessionId?: string;
}

/** Strategy for delegating tasks to agents. */
export interface DelegationStrategy {
  /** Select which agent should handle a task. Returns agent ID or undefined if none suitable. */
  select(agents: readonly AgentRegistration[], task: DelegationTask): Promise<string | undefined> | string | undefined;
}

/** A task to delegate to an agent. */
export interface DelegationTask {
  readonly description: string;
  readonly requirements?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

/** Shared context accessible by all agents in the orchestration. */
export interface SharedContext {
  /** Get a value by key. */
  get(key: string): unknown;
  /** Set a value by key. */
  set(key: string, value: unknown): void;
  /**
   * Wave-13 P0-5: explicitly evict a key. Useful to reclaim space against
   * the `maxSharedContextEntries` cap in long-running orchestrators.
   * Returns true when the key existed.
   */
  delete(key: string): boolean;
  /** Get all entries as a readonly map. */
  entries(): ReadonlyMap<string, unknown>;
}

/** Event emitted by the orchestrator. */
export type OrchestratorEvent =
  | { readonly type: 'agent_registered'; readonly agent: AgentRegistration }
  | { readonly type: 'agent_status_changed'; readonly agentId: string; readonly from: AgentStatus; readonly to: AgentStatus }
  | { readonly type: 'message_sent'; readonly message: AgentMessage }
  | { readonly type: 'message_dropped'; readonly agentId: string; readonly droppedCount: number }
  | { readonly type: 'task_delegated'; readonly agentId: string; readonly task: DelegationTask }
  | { readonly type: 'context_updated'; readonly key: string };

// ---------------------------------------------------------------------------
// Agent Pool types
// ---------------------------------------------------------------------------

/** Configuration for creating an agent pool. */
export interface PoolConfig {
  /** Factory function to create new AgentLoop instances. User controls adapter, tools, config. */
  readonly factory: (role?: string) => import('../core/agent-loop.js').AgentLoop;
  /** Minimum warm (idle) instances. Default: 0. */
  readonly min?: number;
  /** Maximum total instances (hard cap). Default: 10. */
  readonly max?: number;
  /** Milliseconds before idle agents are disposed. Default: 60000. */
  readonly idleTimeout?: number;
  /** Milliseconds before an agent is force-recycled regardless of state. */
  readonly maxAge?: number;
  /**
   * P0-1 (Wave-12): Maximum number of pending async acquire requests that
   * may be queued while the pool is exhausted. When the queue is full,
   * further {@link AgentPool.acquireAsync} calls reject synchronously with
   * {@link HarnessErrorCode.POOL_QUEUE_FULL}. Prevents unbounded memory
   * growth under sustained acquire bursts. Default: 1000.
   */
  readonly maxPendingQueueSize?: number;
}

/** Statistics snapshot for an agent pool. */
export interface PoolStats {
  readonly idle: number;
  readonly active: number;
  readonly total: number;
  readonly created: number;
  readonly recycled: number;
  /** OBS-010: Cumulative count of agent dispose errors silently dropped. */
  readonly disposeErrors: number;
}

/** A handle to an agent acquired from the pool. */
export interface PooledAgent {
  readonly id: string;
  readonly loop: import('../core/agent-loop.js').AgentLoop;
  readonly createdAt: number;
  readonly role?: string;
}

/** Agent pool lifecycle manager. */
export interface AgentPool {
  /** Acquire an idle agent (or create one). Throws if at max capacity. */
  acquire(role?: string): PooledAgent;
  /** Return an agent to the pool. Idempotent. */
  release(agent: PooledAgent): void;
  /** Resize the pool (trim idle or pre-warm). */
  resize(target: number): void;
  /** Wait for all active agents to be released, then dispose. Timeout in ms (default 30000). */
  drain(timeoutMs?: number): Promise<void>;
  /** Current pool statistics. */
  readonly stats: PoolStats;
  /**
   * Dispose all agents and clear timers. Idempotent (LM-014): concurrent
   * callers observe the same completion promise and teardown runs once.
   * Now awaits each underlying `loop.dispose()` so file/socket handles
   * close before the pool is considered fully torn down.
   */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// MessageTransport — minimal interface required by the handoff protocol
// ---------------------------------------------------------------------------

/**
 * Minimal message transport abstraction used by {@link HandoffManager}.
 *
 * Any object that can send inter-agent messages satisfies this interface.
 * The full {@link import('./orchestrator.js').AgentOrchestrator} implements it
 * automatically, but lightweight custom transports can be used as well.
 */
export interface MessageTransport {
  /** Send a message between agents. */
  send(message: Omit<AgentMessage, 'timestamp'>): void;
}

// ---------------------------------------------------------------------------
// Handoff Protocol types
// ---------------------------------------------------------------------------

/** A structured artifact passed between agents. */
export interface HandoffArtifact {
  readonly type: string;
  readonly content: string;
  readonly label?: string;
}

/** Structured payload for an agent-to-agent handoff. */
export interface HandoffPayload {
  readonly summary: string;
  readonly artifacts?: readonly HandoffArtifact[];
  readonly concerns?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly context?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Fix 29: Optional priority for inbox ordering. High-priority handoffs are received first. */
  readonly priority?: 'high' | 'normal' | 'low';
}

/** Receipt for a completed handoff send. */
export interface HandoffReceipt {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly timestamp: number;
  readonly payload: HandoffPayload;
}

/** Result of verifying a handoff's acceptance criteria. */
export interface HandoffVerificationResult {
  readonly passed: boolean;
  readonly violations: readonly string[];
}

/** Structured handoff protocol layered on the orchestrator. */
export interface HandoffManager {
  /**
   * Send a structured handoff from one agent to another.
   *
   * Wave-5E SEC-A10 recommends {@link createSendHandle} for multi-agent
   * deployments so the `from` identity cannot be forged by an untrusted
   * sender; the 3-arg form remains for single-agent setups and tests.
   */
  send(from: string, to: string, payload: HandoffPayload): HandoffReceipt;
  /**
   * Wave-5E SEC-A10: mint a sealed sender handle bound to `from`. Hand
   * this to the originating agent instead of its raw identity string.
   */
  createSendHandle(from: string): import('./handoff.js').SendHandle;
  /** Receive the next pending handoff payload for an agent (FIFO). */
  receive(agentId: string): HandoffPayload | undefined;
  /** Get handoff history involving an agent (as sender or receiver). */
  history(agentId: string): readonly HandoffReceipt[];
  /** Verify a handoff's acceptance criteria against an output. */
  verify(
    receiptId: string,
    output: unknown,
    verifier: (criterion: string, output: unknown) => boolean,
  ): HandoffVerificationResult;
  /** Dispose all handoff state. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Context Boundary types
// ---------------------------------------------------------------------------

/** Access control policy for a specific agent on SharedContext. */
export interface BoundaryPolicy {
  readonly agent: string;
  readonly allowRead?: readonly string[];
  readonly denyRead?: readonly string[];
  readonly allowWrite?: readonly string[];
  readonly denyWrite?: readonly string[];
}

/** A recorded access violation on the context boundary. */
export interface BoundaryViolation {
  readonly type: 'read_denied' | 'write_denied';
  readonly agentId: string;
  readonly key: string;
  readonly timestamp: number;
}

/** Advisory access control boundary on SharedContext. */
export interface BoundedContext {
  /** Get a filtered SharedContext view for a specific agent. */
  forAgent(agentId: string): SharedContext;
  /** Replace all policies. Invalidates cached views. */
  setPolicies(policies: readonly BoundaryPolicy[]): void;
  /** Get the policy for a specific agent. */
  getPolicies(agentId: string): BoundaryPolicy | undefined;
  /** Remove an agent's cached view and policy, preventing memory leaks on agent removal. */
  clearAgent(agentId: string): void;
  /** Get all recorded violations (max 1000). */
  getViolations(): readonly BoundaryViolation[];
}
