/**
 * Example: Dev-time evolve primitives — ComponentRegistry, DriftDetector,
 * TasteCodingRegistry. All live in `@harness-one/devkit`.
 *
 * Purpose: as LLM capabilities change, harness components accrete assumptions
 * that silently rot. These three primitives make the rot observable:
 *
 *   1. `ComponentRegistry`  — declare each component's model assumption +
 *      retirement condition. `validate()` tells you when to delete.
 *   2. `DriftDetector`      — watch numeric or structural signals for
 *      deviation from a baseline (latency, accuracy, cost…).
 *   3. `TasteCodingRegistry` — encode post-mortem lessons as executable
 *      rules; export as Markdown so the rulebook stays reviewable.
 */
import {
  createComponentRegistry,
  createDriftDetector,
  createTasteCodingRegistry,
} from '@harness-one/devkit';

function main(): void {
  // ── 1. ComponentRegistry — retire components when assumptions break ─────
  const components = createComponentRegistry();

  components.register({
    id: 'system-prompt-v1',
    name: 'Legacy system prompt',
    description: 'Mitigates model repeated_tool_failure for GPT-4-turbo',
    modelAssumption: 'gpt-4-turbo behavior, pre-2024-08',
    retirementCondition: 'accuracy >= 0.95', // string DSL: key op value
    createdAt: '2024-03-01',
    tags: ['prompt', 'legacy'],
  });

  components.register({
    id: 'retry-heuristic',
    name: 'Empirical retry heuristic',
    description: 'Retry 3x on ECONNRESET (Anthropic API historical behavior)',
    modelAssumption: 'Anthropic 0.x SDK retry semantics',
    retirementCondition: (ctx) => Boolean(ctx?.sdkHasNativeRetries), // function DSL
    createdAt: '2024-04-15',
    tags: ['adapter', 'anthropic'],
  });

  // Evaluate a component's retirement condition against live metrics:
  const check = components.validate('system-prompt-v1', { accuracy: 0.97 });
  if (!check.valid) {
    console.log(`Retire candidate: ${check.reason}`);
  }

  // List stale components — those not re-validated in the last 30 days.
  components.markValidated('retry-heuristic');
  const stale = components.getStale(30);
  console.log(`Stale components: ${stale.map((c) => c.id).join(', ') || 'none'}`);

  // ── 2. DriftDetector — spot metric drift across deployments ─────────────
  const drift = createDriftDetector({
    thresholds: { low: 0.10, medium: 0.50 }, // above medium = high severity
  });

  // Baseline captured after a known-good deployment:
  drift.setBaseline('agent-latency', { p50: 850, p95: 1800, errorRate: 0.02 });
  drift.setBaseline('cache-hit-rate', { value: 0.82 });

  // At runtime, compare current metrics against the baseline:
  const latencyReport = drift.check('agent-latency', {
    p50: 1250, // +47% — medium severity
    p95: 3500, // +94% — high
    errorRate: 0.025, // 25% worse, but absolute delta small — low
  });
  if (latencyReport.driftDetected) {
    console.log('Latency drift:');
    for (const d of latencyReport.deviations) {
      console.log(`  ${d.field}: ${d.expected} → ${d.actual} [${d.severity}]`);
    }
  }

  // ── 3. TasteCodingRegistry — codify lessons learned ─────────────────────
  const taste = createTasteCodingRegistry();

  taste.addRule({
    id: 'no-as-record-from-json-parse',
    pattern: 'JSON.parse(...) as Record<',
    rule: 'Validate JSON with a schema before narrowing; silent type cast after '
      + 'JSON.parse lets corrupt data through the boundary.',
    enforcement: 'lint', // 'lint' / 'ci' / 'manual'
    createdFrom: 'Incident 2024-09: malformed memory store entry crashed relay',
    createdAt: '2024-09-15',
  });

  taste.addRule({
    id: 'always-dispose-session-manager',
    pattern: 'createSessionManager(',
    rule: 'Call sm.dispose() in your shutdown handler — GC timer leaks otherwise.',
    enforcement: 'ci',
    createdFrom: 'Postmortem 2024-11: 12-hour memory leak in staging',
    createdAt: '2024-11-02',
  });

  // Export as Markdown — commit to the repo so the rulebook is reviewable.
  console.log('\n=== Taste rules (Markdown) ===\n');
  console.log(taste.exportRules());

  console.log(`\nRule count: ${taste.count()}`);
}

main();
