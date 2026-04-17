/**
 * Evolve-check module — architecture-rule checker that stays in `harness-one`
 * proper (runtime safety concern, not a dev-time tool).
 *
 * **Scope (re-confirmed in Wave-15):**
 *
 * - This module ships the rule-checker primitives (`ArchitectureChecker`,
 *   `noCircularDepsRule`, `layerDependencyRule`) so a live harness can
 *   assert invariants at boot or in CI.
 * - Component registry, drift detection, and taste-coding tools live in
 *   `@harness-one/devkit` because they are dev-time workflows, not
 *   request-path safety checks.
 * - The two halves share the rule-result types but not runtime imports —
 *   devkit may consume this module, not the other way around.
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
