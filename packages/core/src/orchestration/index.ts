// Orchestration module — public exports

// Types
export type {
  AgentStatus,
  OrchestrationMode,
  AgentMessage,
  AgentRegistration,
  DelegationStrategy,
  DelegationTask,
  SharedContext,
  OrchestratorEvent,
  SpawnSubAgentConfig,
  SpawnSubAgentResult,
  PoolConfig,
  PoolStats,
  PooledAgent,
  AgentPool,
  MessageTransport,
  HandoffArtifact,
  HandoffPayload,
  HandoffReceipt,
  HandoffVerificationResult,
  HandoffManager,
  BoundaryPolicy,
  BoundaryViolation,
  BoundedContext,
} from './types.js';

// Spawn
export { spawnSubAgent } from './spawn.js';

// Orchestrator
export type {
  AgentOrchestrator,
  OrchestratorConfig,
  // Facets (narrow contracts; consumers should depend on the smallest one
  // they need rather than the full AgentOrchestrator).
  AgentRegistry,
  AgentMessageBus,
  AgentDelegator,
  OrchestratorLifecycle,
  OrchestratorMetrics,
} from './orchestrator.js';
export { createOrchestrator } from './orchestrator.js';

// Strategies
export {
  createBasicRoundRobinStrategy,
  createBasicRandomStrategy,
  createBasicFirstAvailableStrategy,
} from './strategies.js';

// Agent Pool
export { createAgentPool } from './agent-pool.js';

// Handoff Protocol
export { createHandoff } from './handoff.js';

// Context Boundary
export { createContextBoundary } from './context-boundary.js';

// Message Queue
export { createMessageQueue } from './message-queue.js';
export type {
  MessageQueue,
  QueueWarningHandler,
  QueueEventEmitter,
  MessageQueueConfig,
} from './message-queue.js';
