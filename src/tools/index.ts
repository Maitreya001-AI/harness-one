// Tools module — public exports

// Types
export type {
  ToolDefinition,
  ToolFeedback,
  ToolResult,
  ToolCall,
  ValidationError,
} from './types.js';

// Helpers
export { toolSuccess, toolError } from './types.js';

// defineTool
export { defineTool } from './define-tool.js';

// Validation
export { validateToolCall } from './validate.js';

// Registry
export type { ToolRegistry } from './registry.js';
export { createRegistry } from './registry.js';
