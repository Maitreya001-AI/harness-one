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
