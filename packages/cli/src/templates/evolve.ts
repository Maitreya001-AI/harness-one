/**
 * Template for the 'evolve' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules evolve`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import {
  createComponentRegistry,
  createDriftDetector,
} from '@harness-one/devkit';
import {
  createArchitectureChecker,
  noCircularDepsRule,
  layerDependencyRule,
} from 'harness-one/evolve-check';

// 1. Register components with model assumptions and retirement conditions
const registry = createComponentRegistry();

registry.register({
  id: 'context-packer',
  name: 'Context Packer',
  description: 'Packs messages into LLM context window',
  modelAssumption: 'Models have limited context windows (128k-200k tokens)',
  retirementCondition: 'When models support unlimited context natively',
  createdAt: '2025-01-01',
  tags: ['context', 'core'],
});

registry.register({
  id: 'injection-detector',
  name: 'Injection Detector',
  description: 'Detects prompt injection attacks',
  modelAssumption: 'Models are vulnerable to prompt injection',
  retirementCondition: 'When models are immune to injection attacks',
  createdAt: '2025-01-01',
  tags: ['security', 'guardrails'],
});

// 2. Check for stale components that need re-validation
const stale = registry.getStale(90); // Not validated in 90 days
console.log('Stale components:', stale.map(c => c.id));

// 3. Drift detection -- track metric changes over time
const detector = createDriftDetector();
detector.setBaseline('context-packer', { latencyP50: 12, cacheHitRate: 0.85 });

const drift = detector.check('context-packer', { latencyP50: 18, cacheHitRate: 0.72 });
console.log('Drift detected:', drift.driftDetected);
console.log('Deviations:', drift.deviations);

// 4. Architecture rule enforcement
const checker = createArchitectureChecker();

checker.addRule(noCircularDepsRule(['core', 'context', 'tools', 'guardrails']));
checker.addRule(layerDependencyRule({
  core: [],
  context: ['core'],
  tools: ['core'],
  guardrails: ['core'],
  observe: ['core'],
}));

const archResult = checker.check({
  files: ['src/core/index.ts', 'src/context/pack.ts', 'src/tools/registry.ts'],
  imports: {
    'src/context/pack.ts': ['src/core/types.ts'],
    'src/tools/registry.ts': ['src/core/types.ts'],
  },
});
console.log('Architecture check passed:', archResult.passed);
if (!archResult.passed) {
  console.log('Violations:', archResult.violations);
}
`;
