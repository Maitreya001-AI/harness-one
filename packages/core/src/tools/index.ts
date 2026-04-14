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
