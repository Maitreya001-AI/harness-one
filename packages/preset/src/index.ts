/**
 * The `@harness-one/preset` package — Batteries-included harness-one preset with all integrations.
 *
 * Provides a `createHarness()` factory that wires together the core library
 * with provider adapters, observability, memory, validation, and more.
 *
 * The actual wiring lives in `./build-harness/`; this file is the public
 * barrel. Splitting the monolithic `createHarness` body into focused modules
 * (adapter, exporters, memory, guardrails, run) keeps each concern testable
 * and readable while preserving the package's public surface.
 *
 * @module
 */

import { buildHarness } from './build-harness/run.js';
import type { Harness, HarnessConfig } from './build-harness/types.js';

// ---------------------------------------------------------------------------
// Public type + constant re-exports
//
// All of these used to live inline in this file; they were moved to
// `./build-harness/types.ts` to keep the public entry tidy. Re-exporting from
// this module preserves the package's public API (`@harness-one/preset`
// consumers import from the root).
// ---------------------------------------------------------------------------

export {
  DEFAULT_ADAPTER_TIMEOUT_MS,
  DRAIN_DEFAULT_TIMEOUT_MS,
} from './build-harness/types.js';
export type {
  HarnessConfigBase,
  AnthropicHarnessConfig,
  OpenAIHarnessConfig,
  AdapterHarnessConfig,
  HarnessConfig,
  Tokenizer,
  Harness,
} from './build-harness/types.js';

/**
 * Create a fully-wired Harness instance.
 *
 * Every auto-configured component can be overridden by passing the
 * explicit config field.
 *
 * Thin delegate to `buildHarness` in `./build-harness/run.ts`; the
 * implementation lives there so this module stays focused on the public
 * barrel.
 *
 * @example
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk';
 * import { createHarness } from '@harness-one/preset';
 *
 * const harness = createHarness({
 *   provider: 'anthropic',
 *   client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
 *   model: 'claude-sonnet-4-20250514',
 *   budget: 5.0,
 * });
 * ```
 */
export function createHarness(config: HarnessConfig): Harness {
  return buildHarness(config);
}

// ---------------------------------------------------------------------------
// Environment configuration helper
// ---------------------------------------------------------------------------

export { createConfigFromEnv } from './env.js';

// ---------------------------------------------------------------------------
// Opinionated fail-closed preset wiring
// ---------------------------------------------------------------------------

export { createSecurePreset } from './secure.js';
export type { SecurePresetGuardrailLevel, SecurePresetOptions, SecureHarness } from './secure.js';

// ---------------------------------------------------------------------------
// Graceful shutdown handler
// ---------------------------------------------------------------------------

export { createShutdownHandler } from './shutdown.js';
export type { ShutdownHandlerOptions } from './shutdown.js';

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

export {
  validateHarnessConfig,
  validateHarnessRuntimeConfig,
  validateHarnessConfigAll,
} from './validate-config.js';
