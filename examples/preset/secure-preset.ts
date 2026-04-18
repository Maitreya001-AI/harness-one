/**
 * Example: createSecurePreset — production-grade Harness with fail-closed defaults.
 *
 * This is the recommended production entry point (see docs/architecture/00-overview.md).
 * Differences from `createHarness`:
 *   - Guardrail pipeline is non-empty by default (injection + contentFilter + PII).
 *   - Logger defaults to `createDefaultLogger` (redaction on).
 *   - OpenAI provider registry sealed after construction — attacker-controlled
 *     `registerProvider()` calls later in the process lifetime are blocked.
 *
 * Install peer deps (demo uses Anthropic):
 *   pnpm add @anthropic-ai/sdk
 */

import Anthropic from '@anthropic-ai/sdk';
import { createSecurePreset, type SecureHarness } from '@harness-one/preset';

async function main(): Promise<void> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Default guardrailLevel is 'standard' — injection + contentFilter + PII.
  // Levels: 'minimal' (injection only), 'standard' (default), 'strict' (+ rate-limit).
  const harness: SecureHarness = createSecurePreset({
    provider: 'anthropic',
    client,
    model: 'claude-sonnet-4-20250514',
    guardrailLevel: 'standard',
    // Override individual guardrails without losing the preset:
    guardrails: {
      rateLimit: { max: 60, windowMs: 60_000 }, // opt into rate-limit on 'standard'
      pii: { types: ['email', 'phone', 'creditCard'] },
    },
    budget: 0.5, // USD ceiling — costs: getTotalCost() drives the alert pipeline
  });

  // ── harness.run() is an AsyncGenerator — consume events ─────────────────
  for await (const event of harness.run(
    [{ role: 'user', content: 'Briefly explain KV-cache stability in 2 sentences.' }],
    {
      // Supply a per-request session id to isolate conversation histories.
      sessionId: 'demo-user-123',
      onSessionId: (id) => console.log('Effective session:', id),
    },
  )) {
    if (event.type === 'text_delta') process.stdout.write(event.text);
    if (event.type === 'done') {
      console.log('\nDone:', event.reason, event.totalUsage);
      break;
    }
  }

  // ── SecureHarness additions (beyond the base Harness interface) ─────────
  // 1. Aggregated health check — returns { state, components } where
  //    components is a map of componentName → { status, ... }.
  const health = await harness.lifecycle.health();
  console.log('Health:', health.state, Object.keys(health.components));

  // 2. MetricsPort — vendor-neutral counter/gauge/histogram. The port hands
  //    back lazy instruments; call `.add()` / `.record()` on the result.
  //    Swap in an OTel adapter from `@harness-one/opentelemetry` in production.
  const runCounter = harness.metrics.counter('demo.runs');
  runCounter.add(1, { model: 'claude-sonnet-4-20250514' });

  // ── Graceful shutdown ────────────────────────────────────────────────────
  // drain() flushes in-flight traces/costs and refuses new work; default
  // timeout is DRAIN_DEFAULT_TIMEOUT_MS (30s).
  await harness.drain(5_000);
}

main().catch((err) => {
  console.error('Run failed:', err);
  process.exit(1);
});
