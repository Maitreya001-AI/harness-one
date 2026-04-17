/**
 * Extension-point barrel for `harness-one` — the primitives that framework
 * authors, adapter implementers, and custom-loop builders compose with,
 * intentionally kept separate from the end-user surface in `harness-one/core`.
 *
 * The end-user surface (`harness-one/core`) is the stable, narrow API a
 * typical consumer needs: `createAgentLoop`, hooks, errors, message types,
 * model pricing, the two tracing ports. Everything here is a lower-level
 * building block — exposed so advanced callers can compose, but not part
 * of the stable contract in the same way: signatures may tighten as the
 * internals are refactored.
 *
 * @module
 */

// ─── Middleware + tracing hook plumbing ──────────────────────────────────
export type { MiddlewareContext, MiddlewareFn, MiddlewareChain } from '../core/middleware.js';
export { createMiddlewareChain } from '../core/middleware.js';
export type { AgentLoopTraceManager } from '../core/trace-interface.js';

// ─── Stream aggregation (for custom adapter stream() generators) ─────────
export { StreamAggregator } from '../core/stream-aggregator.js';
export type {
  StreamAggregatorEvent,
  StreamAggregatorChunk,
  StreamAggregatorMessage,
  StreamAggregatorOptions,
} from '../core/stream-aggregator.js';

// ─── Output parsing + retry ───────────────────────────────────────────────
export type { OutputParser } from '../core/output-parser.js';
export { createJsonOutputParser, parseWithRetry } from '../core/output-parser.js';

// ─── Fallback adapter composition ─────────────────────────────────────────
export type { FallbackAdapterConfig } from '../core/fallback-adapter.js';
export { createFallbackAdapter } from '../core/fallback-adapter.js';

// ─── SSE streaming helpers ────────────────────────────────────────────────
export type { SSEChunk } from '../core/sse-stream.js';
export { toSSEStream, formatSSE } from '../core/sse-stream.js';

// ─── Execution strategies (sequential / parallel tool dispatch) ──────────
export { createSequentialStrategy, createParallelStrategy } from '../core/execution-strategies.js';

// ─── Error classification ─────────────────────────────────────────────────
export { categorizeAdapterError } from '../core/error-classifier.js';
export { createCustomErrorCode } from '../core/errors.js';
export type { HarnessErrorDetails } from '../core/errors.js';

// ─── Conversation pruning ─────────────────────────────────────────────────
export type { PruneResult } from '../core/conversation-pruner.js';
export { pruneConversation } from '../core/conversation-pruner.js';

// ─── Resilient-loop composition ───────────────────────────────────────────
export type { ResilientLoopConfig, ResilientLoop } from '../core/resilience.js';
export { createResilientLoop } from '../core/resilience.js';
export type { ResiliencePolicy } from '../core/retry-policy.js';

// ─── Iteration coordinator (Wave-15 state machine) ───────────────────────
export {
  startRun,
  checkPreIteration,
  startIteration,
  finalizeRun,
} from '../core/iteration-coordinator.js';
export type {
  CoordinatorDeps,
  CoordinatorState,
  StartRunResult,
} from '../core/iteration-coordinator.js';

// ─── Shared validators + pricing math ────────────────────────────────────
export {
  requirePositiveInt,
  requireNonNegativeInt,
  requireFinitePositive,
  requireFiniteNonNegative,
  requireUnitInterval,
  validatePricingEntry,
  validatePricingArray,
} from '../infra/validate.js';
export type { PricingNumericFields } from '../infra/validate.js';
export { priceUsage, hasNonFiniteTokens } from '../core/pricing.js';

// ─── Backoff primitives ───────────────────────────────────────────────────
export {
  ADAPTER_RETRY_JITTER_FRACTION,
  AGENT_POOL_IDLE_JITTER_FRACTION,
  computeBackoffMs,
  computeJitterMs,
  createBackoffSchedule,
} from '../infra/backoff.js';
export type { BackoffConfig, BackoffSchedule } from '../infra/backoff.js';

// ─── Trusted system-message factories (Wave-5E SEC-A07) ──────────────────
export {
  createTrustedSystemMessage,
  isTrustedSystemMessage,
  sanitizeRestoredMessage,
} from '../core/trusted-system-message.js';

// ─── Test utilities (for adapter / loop tests) ───────────────────────────
export type { MockAdapterConfig } from '../core/test-utils.js';
export {
  createMockAdapter,
  createFailingAdapter,
  createStreamingMockAdapter,
  createErrorStreamingMockAdapter,
} from '../core/test-utils.js';
