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

// ─── Adapter stream limits (shared with anthropic/openai adapters) ───────
export { MAX_STREAM_BYTES, MAX_TOOL_ARG_BYTES, MAX_TOOL_CALLS } from '../core/agent-loop-config.js';

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
export { isRetryableHarnessErrorCode } from '../core/error-span-attributes.js';

// ─── Conversation pruning ─────────────────────────────────────────────────
export type { PruneResult } from '../core/conversation-pruner.js';
export { pruneConversation } from '../core/conversation-pruner.js';

// ─── Resilient-loop composition ───────────────────────────────────────────
export type { ResilientLoopConfig, ResilientLoop } from '../core/resilience.js';
export { createResilientLoop } from '../core/resilience.js';
export type { ResiliencePolicy } from '../core/retry-policy.js';

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

// ─── Circuit breaker (protect downstream dependencies) ───────────────────
// Previously internal-only; exported so the fourth resilience mechanism in
// docs/guides/resilience.md is actually reachable — wrap tool-level HTTP /
// vector-DB calls with it. Not wired into AgentLoopConfig by design; see
// the guide's composition rules.
export { createCircuitBreaker, CircuitOpenError } from '../infra/circuit-breaker.js';
export type { CircuitBreaker, CircuitBreakerConfig, CircuitState, CircuitStateChangeContext } from '../infra/circuit-breaker.js';

// ─── Trusted system-message factories ────────────────────────────────────
export {
  createTrustedSystemMessage,
  isTrustedSystemMessage,
  sanitizeRestoredMessage,
} from '../core/trusted-system-message.js';

// ─── Injectable clock port ────────────────────────────────────────────────
// Extension authors composing custom loops / stores can inject a virtual
// clock for deterministic duration budgets, TTL expiry, and timestamps.
export { systemClock } from '../infra/clock.js';
export type { Clock } from '../infra/clock.js';

// ─── Instance-scoped tokenizer registry ───────────────────────────────────
// Library authors embedding harness-one should prefer an isolated registry
// over the process-wide `registerTokenizer` default — see its TSDoc.
export { createTokenizerRegistry } from '../infra/token-estimator.js';
export type { TokenizerRegistry, Tokenizer } from '../infra/token-estimator.js';

// Test utilities moved to `harness-one/testing`.
// Rationale: `createMockAdapter` / `createFailingAdapter` /
// `createStreamingMockAdapter` / `createErrorStreamingMockAdapter` are mock
// AgentAdapter factories for tests only. Sharing the /advanced surface with
// production extension primitives (middleware, resilient-loop, fallback,
// output parsers) misled adapter authors into treating them as a supported
// production surface. Import from `harness-one/testing` in test code:
//
//   import { createMockAdapter } from 'harness-one/testing';
//
// See docs/architecture/14-advanced.md and 17-testing.md.
