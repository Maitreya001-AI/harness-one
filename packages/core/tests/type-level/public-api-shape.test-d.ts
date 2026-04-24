/**
 * N7 · Public API shape lockfile.
 *
 * This file is the **canonical sentinel** for every public subpath
 * barrel. It imports each subpath as a namespace, then matches the
 * namespace against an inline reference shape listing the committed
 * exports.
 *
 * Any breaking change to the public surface MUST touch this file:
 *
 *   - Renaming a function → reference shape no longer matches → tsc
 *     error on the `toMatchTypeOf<Expected...>()` line.
 *   - Removing a function → same.
 *   - Tightening a function's signature → same.
 *
 * ADDITIVE changes (new exports, optional parameters) do NOT require
 * an update: `toMatchTypeOf` accepts supersets. This asymmetry is
 * intentional — the test is a ratchet that catches removals, not a
 * pin that rejects growth.
 *
 * PR reviewer rule: any diff on this file is a public-API change and
 * must appear in the CHANGELOG.
 */
// `Function` is the precise type here: we want to assert the export is
// callable/constructable without duplicating every signature. Disabling
// the lint rule is scoped to this sentinel file and explicitly reviewed.
/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import { expectTypeOf } from 'expect-type';

import type * as core from 'harness-one';
import type * as coreSub from 'harness-one/core';
import type * as advanced from 'harness-one/advanced';
import type * as testing from 'harness-one/testing';
import type * as preset from '@harness-one/preset';
import type * as anthropic from '@harness-one/anthropic';
import type * as openai from '@harness-one/openai';

// ─────────────────────────────────────────────────────────────────────────
// harness-one (root barrel)
// ─────────────────────────────────────────────────────────────────────────
// The root barrel curates the 18 value exports that every end-user needs.
// Type-only re-exports aren't visible on `typeof core`, so they are
// covered by N1–N6 (events, branded ids, config, trusted-system,
// memory caps, metrics-port) instead.
type ExpectedCoreShape = {
  readonly createAgentLoop: Function;
  readonly AgentLoop: Function;
  readonly createResilientLoop: Function;
  readonly createMiddlewareChain: Function;
  readonly HarnessError: Function;
  readonly MaxIterationsError: Function;
  readonly AbortedError: Function;
  readonly ToolValidationError: Function;
  readonly TokenBudgetExceededError: Function;
  readonly HarnessErrorCode: object;
  readonly defineTool: Function;
  readonly createRegistry: Function;
  readonly createPipeline: Function;
  readonly createTraceManager: Function;
  readonly createLogger: Function;
  readonly createCostTracker: Function;
  readonly createSessionManager: Function;
  readonly disposeAll: Function;
};
expectTypeOf<typeof core>().toMatchTypeOf<ExpectedCoreShape>();

// ─────────────────────────────────────────────────────────────────────────
// harness-one/core (end-user surface)
// ─────────────────────────────────────────────────────────────────────────
type ExpectedCoreSubShape = {
  readonly createAgentLoop: Function;
  readonly AgentLoop: Function;
  readonly HarnessError: Function;
  readonly HarnessErrorCode: object;
  readonly MaxIterationsError: Function;
  readonly AbortedError: Function;
  readonly ToolValidationError: Function;
  readonly TokenBudgetExceededError: Function;
  readonly assertNever: Function;
};
expectTypeOf<typeof coreSub>().toMatchTypeOf<ExpectedCoreSubShape>();

// ─────────────────────────────────────────────────────────────────────────
// harness-one/advanced (extension primitives)
// ─────────────────────────────────────────────────────────────────────────
type ExpectedAdvancedShape = {
  readonly createMiddlewareChain: Function;
  readonly MAX_STREAM_BYTES: number;
  readonly MAX_TOOL_ARG_BYTES: number;
  readonly MAX_TOOL_CALLS: number;
  readonly StreamAggregator: Function;
  readonly createJsonOutputParser: Function;
  readonly parseWithRetry: Function;
  readonly createFallbackAdapter: Function;
  readonly toSSEStream: Function;
  readonly formatSSE: Function;
  readonly createSequentialStrategy: Function;
  readonly createParallelStrategy: Function;
  readonly categorizeAdapterError: Function;
  readonly createCustomErrorCode: Function;
  readonly isRetryableHarnessErrorCode: Function;
  readonly pruneConversation: Function;
  readonly createResilientLoop: Function;
  readonly requirePositiveInt: Function;
  readonly requireNonNegativeInt: Function;
  readonly requireFinitePositive: Function;
  readonly requireFiniteNonNegative: Function;
  readonly requireUnitInterval: Function;
  readonly validatePricingEntry: Function;
  readonly validatePricingArray: Function;
  readonly priceUsage: Function;
  readonly hasNonFiniteTokens: Function;
  readonly ADAPTER_RETRY_JITTER_FRACTION: number;
  readonly AGENT_POOL_IDLE_JITTER_FRACTION: number;
  readonly computeBackoffMs: Function;
  readonly computeJitterMs: Function;
  readonly createBackoffSchedule: Function;
  readonly createTrustedSystemMessage: Function;
  readonly isTrustedSystemMessage: Function;
  readonly sanitizeRestoredMessage: Function;
};
expectTypeOf<typeof advanced>().toMatchTypeOf<ExpectedAdvancedShape>();

// ─────────────────────────────────────────────────────────────────────────
// harness-one/testing (mock adapters — TEST-ONLY surface)
// ─────────────────────────────────────────────────────────────────────────
type ExpectedTestingShape = {
  readonly createMockAdapter: Function;
  readonly createFailingAdapter: Function;
  readonly createStreamingMockAdapter: Function;
  readonly createErrorStreamingMockAdapter: Function;
};
expectTypeOf<typeof testing>().toMatchTypeOf<ExpectedTestingShape>();

// ─────────────────────────────────────────────────────────────────────────
// @harness-one/preset (opinionated wiring)
// ─────────────────────────────────────────────────────────────────────────
type ExpectedPresetShape = {
  readonly createHarness: Function;
  readonly createConfigFromEnv: Function;
  readonly createSecurePreset: Function;
  readonly createShutdownHandler: Function;
  readonly validateHarnessConfig: Function;
  readonly validateHarnessRuntimeConfig: Function;
  readonly validateHarnessConfigAll: Function;
  readonly DEFAULT_ADAPTER_TIMEOUT_MS: number;
  readonly DRAIN_DEFAULT_TIMEOUT_MS: number;
};
expectTypeOf<typeof preset>().toMatchTypeOf<ExpectedPresetShape>();

// ─────────────────────────────────────────────────────────────────────────
// @harness-one/anthropic (Anthropic SDK adapter)
// ─────────────────────────────────────────────────────────────────────────
type ExpectedAnthropicShape = {
  readonly createAnthropicAdapter: Function;
  readonly _resetWarnedUnknownSchemaKeysForTesting: Function;
};
expectTypeOf<typeof anthropic>().toMatchTypeOf<ExpectedAnthropicShape>();

// ─────────────────────────────────────────────────────────────────────────
// @harness-one/openai (OpenAI SDK + OpenAI-compatible adapter)
// ─────────────────────────────────────────────────────────────────────────
type ExpectedOpenAIShape = {
  readonly providers: object;
  readonly registerProvider: Function;
  readonly sealProviders: Function;
  readonly isProvidersSealed: Function;
  readonly createOpenAIAdapter: Function;
  readonly _resetOpenAIWarnState: Function;
};
expectTypeOf<typeof openai>().toMatchTypeOf<ExpectedOpenAIShape>();
