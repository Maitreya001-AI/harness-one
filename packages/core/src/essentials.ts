/**
 * `harness-one/essentials` — the curated 12-symbol entry point.
 *
 * ARCH-003: the root `harness-one` barrel re-exports ~90 symbols from 18
 * submodule groups. This entry pares the surface down to the dozen most-used
 * primitives so first-time users (and tree-shakers) only see what they need.
 *
 * Everything here is also exported from `harness-one` (the root barrel) and
 * from the appropriate submodule (`harness-one/core`, `harness-one/observe`,
 * etc.). This file does NOT add new public API — it is a curated re-export
 * layer only.
 *
 * @example
 * ```ts
 * // 90% of users need only this single import:
 * import {
 *   AgentLoop,
 *   createAgentLoop,
 *   defineTool,
 *   createRegistry,
 *   createTraceManager,
 *   createLogger,
 * } from 'harness-one/essentials';
 * ```
 *
 * @module
 */

// 1. AgentLoop core
export { AgentLoop, createAgentLoop } from './core/agent-loop.js';

// 2. Error taxonomy
export { HarnessError, MaxIterationsError, AbortedError } from './core/errors.js';

// 3. Tools
export { defineTool, createRegistry } from './tools/index.js';

// 4. Observability
export { createTraceManager, createLogger } from './observe/index.js';

// 5. Sessions
export { createSessionManager } from './session/index.js';

// 6. Middleware
export { createMiddlewareChain } from './core/middleware.js';

// 7. Guardrails
export { createPipeline } from './guardrails/index.js';
