/**
 * createSecurePreset — opinionated fail-closed preset wiring.
 *
 * Wraps {@link createHarness} with opinionated secure defaults:
 * - Guardrail pipeline is non-empty by default (injection + contentFilter + pii)
 * - Logger defaults to {@link createDefaultLogger} (redaction on)
 * - OpenAI provider registry is sealed after construction
 *
 * There is no "guardrails off" escape hatch. Callers who need that must use
 * {@link createHarness} directly and accept responsibility for insecure config.
 *
 * @module
 */

import { sealProviders } from '@harness-one/openai';
import { createDefaultLogger } from 'harness-one/observe';
import { createHarnessLifecycle, createNoopMetricsPort } from 'harness-one/observe';
import type { HarnessLifecycle, MetricsPort } from 'harness-one/observe';

import { createHarness, type Harness, type HarnessConfig } from './index.js';
import { validateHarnessConfig } from './validate-config.js';

/**
 * Preset levels for the default guardrail pipeline.
 *
 * - `'minimal'`  — injection detector only (low sensitivity)
 * - `'standard'` — injection + contentFilter + PII detector. **Default.**
 * - `'strict'`   — standard + rateLimit (60 req/min) + injection sensitivity high
 *
 * User-supplied `guardrails` fields override the preset for the same keys,
 * so `createSecurePreset({ guardrailLevel: 'standard', guardrails: { pii: false } })`
 * disables PII but keeps injection + contentFilter active.
 */
export type SecurePresetGuardrailLevel = 'minimal' | 'standard' | 'strict';

/** Extra options accepted only by {@link createSecurePreset}. */
export interface SecurePresetOptions {
  /** Guardrail preset level. Defaults to `'standard'`. */
  readonly guardrailLevel?: SecurePresetGuardrailLevel;

  /**
   * If `true`, `sealProviders()` is NOT called after construction.
   * Rare escape hatch — only meaningful if the caller expects to register
   * additional OpenAI-compatible providers *after* building the Harness.
   * Defaults to `false` (seal on).
   */
  readonly skipProviderSeal?: boolean;
}

type HarnessGuardrails = NonNullable<HarnessConfig['guardrails']>;

/** Extended Harness returned by `createSecurePreset` with lifecycle + metrics. */
export interface SecureHarness extends Harness {
  /** Lifecycle state machine for health checks and drain coordination. */
  readonly lifecycle: HarnessLifecycle;
  /** Vendor-neutral metrics port (no-op by default; wire an OTel adapter for real metrics). */
  readonly metrics: MetricsPort;
}

/**
 * Create a Harness with fail-closed security defaults and opinionated wiring.
 *
 * Differences from {@link createHarness}:
 * 1. `guardrails` pipeline is non-empty — at minimum an injection detector.
 * 2. `logger` defaults to {@link createDefaultLogger} (redaction on).
 * 3. `sealProviders()` is invoked after the adapter is constructed so
 *    {@link registerProvider} cannot be called with attacker-controlled
 *    configuration later in the process lifetime.
 *
 * Tool registry security (default `allowedCapabilities: ['readonly']`) and
 * logger/trace-manager redaction defaults are inherited from core-level
 * secure defaults — no extra wiring needed here.
 *
 * @example
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk';
 * import { createSecurePreset } from '@harness-one/preset';
 *
 * const harness = createSecurePreset({
 *   provider: 'anthropic',
 *   client: new Anthropic({ apiKey: process.env.ANTHROPIC_KEY }),
 *   model: 'claude-sonnet-4-20250514',
 *   // guardrailLevel defaults to 'standard'
 * });
 * ```
 */
export function createSecurePreset(config: HarnessConfig & SecurePresetOptions): SecureHarness {
  // Unified structural validation — catches typos, invalid enum values,
  // and unrecognized keys at construction time with actionable errors.
  validateHarnessConfig(config as unknown as Record<string, unknown>);

  const level: SecurePresetGuardrailLevel = config.guardrailLevel ?? 'standard';

  const guardrails = mergeSecureGuardrails(level, config.guardrails);
  const logger = config.logger ?? createDefaultLogger();

  // Strip SecurePresetOptions fields from the config passed down to createHarness,
  // since HarnessConfig doesn't know about guardrailLevel / skipProviderSeal.
  const { guardrailLevel: _gl, skipProviderSeal: _sps, ...rest } = config;
  void _gl;
  void _sps;

  const mergedConfig = {
    ...rest,
    guardrails,
    logger,
  } as HarnessConfig;

  const harness = createHarness(mergedConfig);

  if (config.skipProviderSeal !== true) {
    // Idempotent: second call is a no-op, so invoking createSecurePreset
    // multiple times in one process is safe.
    sealProviders();
  }

  // Wire lifecycle state machine with core component health checks.
  const lifecycle = createHarnessLifecycle();

  lifecycle.registerHealthCheck('traceManager', () => {
    // TraceManager is stateless beyond its export queue; if it exists, it's up.
    return { status: 'up' };
  });

  lifecycle.registerHealthCheck('sessions', () => {
    return { status: 'up' };
  });

  // Metrics port — no-op by default. Callers can replace this with an OTel
  // adapter via `@harness-one/opentelemetry`.
  const metrics = createNoopMetricsPort();

  // Transition to ready after construction.
  lifecycle.markReady();

  return {
    ...harness,
    lifecycle,
    metrics,
    // Override shutdown to coordinate with lifecycle state machine.
    async shutdown(): Promise<void> {
      lifecycle.beginDrain();
      try {
        await harness.shutdown();
      } finally {
        lifecycle.completeShutdown();
      }
    },
    async drain(timeoutMs?: number): Promise<void> {
      lifecycle.beginDrain();
      try {
        await harness.drain(timeoutMs);
      } finally {
        lifecycle.completeShutdown();
      }
    },
  };
}

/**
 * Merge the preset-level default guardrail config with user overrides.
 *
 * Strategy: user-specified fields take precedence key-by-key. Fields the user
 * does not mention get the preset-level default. This means callers can
 * tighten or loosen individual guards without being forced to re-spell the
 * full shape.
 */
function mergeSecureGuardrails(
  level: SecurePresetGuardrailLevel,
  userGuardrails: HarnessGuardrails | undefined,
): HarnessGuardrails {
  const base: Record<string, unknown> = {};

  // Injection detector — always on; sensitivity scales with level.
  base.injection = level === 'strict' ? { sensitivity: 'high' as const } : true;

  if (level === 'standard' || level === 'strict') {
    base.contentFilter = {};
    base.pii = true;
  }

  if (level === 'strict') {
    base.rateLimit = { max: 60, windowMs: 60_000 };
  }

  // User fields override base
  return { ...base, ...userGuardrails } as HarnessGuardrails;
}
