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
} from './types.js';

// Spawn
export { spawnSubAgent } from './spawn.js';

// Orchestrator
export type { AgentOrchestrator, OrchestratorConfig } from './orchestrator.js';
export { createOrchestrator } from './orchestrator.js';

// Strategies
export {
  createRoundRobinStrategy,
  createRandomStrategy,
  createFirstAvailableStrategy,
} from './strategies.js';
