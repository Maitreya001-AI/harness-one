/**
 * Example · Evolve-check primitives — "the code keeps being right."
 *
 * Demonstrates three primitives from `@harness-one/devkit` that detect
 * when components in a long-lived codebase silently rot:
 *
 *   1. ComponentRegistry — explicit `modelAssumption` + `retirementCondition`
 *      per component.
 *   2. DriftDetector     — compares live metrics to a baseline and tags
 *      each deviation with a severity.
 *   3. TasteCodingRegistry — executable post-mortem rules, exported as
 *      Markdown so maintainers can review them in a PR.
 *
 * The example drives the registries with deterministic inputs so it runs
 * under `examples:smoke` without network or LLM.
 *
 *   pnpm tsx examples/evolve-check-demo.ts
 */
import {
  createComponentRegistry,
  createDriftDetector,
  createTasteCodingRegistry,
} from '@harness-one/devkit';

function registerComponents(): ReturnType<typeof createComponentRegistry> {
  const components = createComponentRegistry();
  components.register({
    id: 'system-prompt-v1',
    name: 'Legacy GPT-4 system prompt',
    description: 'Worked around GPT-4-turbo tool-selection bias before 2024-08.',
    modelAssumption: 'gpt-4-turbo behavior, pre-2024-08',
    retirementCondition: 'accuracy >= 0.95',
    createdAt: '2024-03-01',
    tags: ['prompt', 'legacy'],
  });
  components.register({
    id: 'retry-heuristic',
    name: 'ECONNRESET retry wrapper',
    description: 'Retried 3x on ECONNRESET before Anthropic SDK learned native retry.',
    modelAssumption: 'Anthropic 0.x SDK retry semantics',
    retirementCondition: (ctx) => Boolean(ctx?.['sdkHasNativeRetries']),
    createdAt: '2024-04-10',
    tags: ['infra'],
  });
  components.register({
    id: 'json-fallback-coerce',
    name: 'JSON tool-call output coercion',
    description:
      'Coerced malformed tool_use arguments before guardrail pipeline ran — '
      + 'no longer needed with the hard `maxToolArgBytes` guard in adapters.',
    modelAssumption: 'ad-hoc coercion on client side',
    retirementCondition: 'enforced_hard_limit == true',
    createdAt: '2024-05-01',
    tags: ['adapter'],
  });
  return components;
}

function driftNarrative(): void {
  const drift = createDriftDetector({ thresholds: { low: 0.1, medium: 0.5 } });
  drift.setBaseline('agent-latency', { p50: 850, p95: 1800, errorRate: 0.02 });
  drift.setBaseline('cache-hit-rate', { value: 0.82 });

  const latency = drift.check('agent-latency', {
    p50: 1250, // +47% — medium
    p95: 3500, // +94% — high
    errorRate: 0.025,
  });
  console.log(`\n[drift] agent-latency detected=${latency.driftDetected}`);
  for (const dev of latency.deviations) {
    console.log(`  ${dev.field}: ${dev.expected} → ${dev.actual} [${dev.severity}]`);
  }

  const cache = drift.check('cache-hit-rate', { value: 0.72 });
  console.log(`[drift] cache-hit-rate detected=${cache.driftDetected}`);
  for (const dev of cache.deviations) {
    console.log(`  ${dev.field}: ${dev.expected} → ${dev.actual} [${dev.severity}]`);
  }
}

function tasteCoding(): void {
  const taste = createTasteCodingRegistry();
  taste.addRule({
    id: 'no-as-record-from-json-parse',
    pattern: 'JSON.parse(...) as Record<',
    rule:
      'Validate JSON with a schema before narrowing; a raw `as Record<...>` after '
      + 'JSON.parse lets corrupt data slide past the boundary.',
    enforcement: 'lint',
    createdFrom: 'Incident 2024-09: malformed memory-store entry crashed the relay',
    createdAt: '2024-09-15',
  });
  taste.addRule({
    id: 'always-dispose-session-manager',
    pattern: 'createSessionManager(',
    rule: 'Call `sm.dispose()` in the shutdown handler — otherwise GC timers leak.',
    enforcement: 'ci',
    createdFrom: 'Postmortem 2024-11: 12-hour memory creep in staging',
    createdAt: '2024-11-02',
  });

  console.log('\n=== Taste rules (Markdown) ===\n');
  console.log(taste.exportRules());
  console.log(`\nRule count: ${taste.count()}`);
}

function main(): void {
  // ── Step 1: declare components + current runtime context ─────────────────
  const components = registerComponents();

  const runtimeCtx: Record<string, unknown> = {
    accuracy: 0.97, // legacy prompt is finally safe to retire
    sdkHasNativeRetries: true, // Anthropic SDK 0.30 ships native retries
    enforced_hard_limit: false, // we haven't flipped the hard-limit yet
  };

  console.log('=== Component retirement audit ===');
  for (const component of components.list()) {
    const check = components.validate(component.id, runtimeCtx);
    if (!check.valid) {
      console.log(`RETIRE ${component.id}: ${check.reason}`);
    } else {
      console.log(`KEEP   ${component.id}: ${check.reason}`);
    }
  }

  // ── Step 2: drift detection ──────────────────────────────────────────────
  driftNarrative();

  // ── Step 3: taste rules / executable post-mortems ────────────────────────
  tasteCoding();
}

main();
