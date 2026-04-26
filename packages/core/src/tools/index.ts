// Tools module — public exports

// Types
export type {
  ToolDefinition,
  ToolMiddleware,
  ToolFeedback,
  ToolResult,
  ToolCall,
  ValidationError,
  SchemaValidator,
  ToolCapabilityValue,
} from './types.js';

// Helpers + capability enum
export { toolSuccess, toolError, ToolCapability, ALL_TOOL_CAPABILITIES } from './types.js';

// defineTool
export { defineTool } from './define-tool.js';

// Validation
export { validateToolCall } from './validate.js';

// Registry
export type { ToolRegistry, ResolvedRegistryConfig, CreateRegistryConfig } from './registry.js';
export { createRegistry, createPermissiveRegistry } from './registry.js';

// ── Cross-subpath ergonomic re-exports (zero runtime cost) ─────────────────
//
// `ToolSchema` is the AgentLoop-facing tool shape that consumers must
// build when wiring tool definitions into the loop. Its canonical home
// is `harness-one/core` (next to AgentLoopConfig) but every consumer
// already importing from `harness-one/tools` reaches for it here first.
// Re-exporting as type-only keeps the bundle cost zero.
// See HARNESS_LOG HC-006.
export type { ToolSchema, ToolCallRequest, ToolExecutionResult } from '../core/types.js';
