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
  /** Get all entries as a readonly map. */
  entries(): ReadonlyMap<string, unknown>;
}

/** Event emitted by the orchestrator. */
export type OrchestratorEvent =
  | { readonly type: 'agent_registered'; readonly agent: AgentRegistration }
  | { readonly type: 'agent_status_changed'; readonly agentId: string; readonly from: AgentStatus; readonly to: AgentStatus }
  | { readonly type: 'message_sent'; readonly message: AgentMessage }
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
}

/** Statistics snapshot for an agent pool. */
export interface PoolStats {
  readonly idle: number;
  readonly active: number;
  readonly total: number;
  readonly created: number;
  readonly recycled: number;
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
  /** Dispose all agents and clear timers. */
  dispose(): void;
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
  /** Send a structured handoff from one agent to another. */
  send(from: string, to: string, payload: HandoffPayload): HandoffReceipt;
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
  /** Get all recorded violations (max 1000). */
  getViolations(): readonly BoundaryViolation[];
}
