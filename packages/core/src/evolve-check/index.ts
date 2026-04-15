/**
 * Evolve-check module — architecture-rule checker that stays in `harness-one`
 * proper (runtime safety concern, not a dev-time tool).
 *
 * The rest of the former `evolve/` surface (component registry, drift
 * detection, taste-coding) lives in `@harness-one/devkit`.
 *
 * @module
 */

export type { ArchitectureRule, RuleContext, RuleResult } from './types.js';
export type { ArchitectureChecker } from './architecture-checker.js';
export {
  createArchitectureChecker,
  noCircularDepsRule,
  layerDependencyRule,
} from './architecture-checker.js';
