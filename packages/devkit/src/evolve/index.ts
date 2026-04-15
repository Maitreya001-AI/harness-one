/**
 * Evolve module — component registry, drift detection, architecture rules, and taste-coding.
 *
 * @module
 */

// Types
export type {
  ComponentMeta,
  DriftReport,
  DriftDeviation,
  ArchitectureRule,
  RuleContext,
  RuleResult,
  TasteCodingRule,
} from './types.js';

// Component registry
export type { ComponentRegistry } from './component-registry.js';
export { createComponentRegistry } from './component-registry.js';

// Drift detector
export type { DriftDetector, DriftDetectorConfig } from './drift-detector.js';
export { createDriftDetector } from './drift-detector.js';

// Architecture checker
export type { ArchitectureChecker } from './architecture-checker.js';
export { createArchitectureChecker, noCircularDepsRule, layerDependencyRule } from './architecture-checker.js';

// Taste-coding
export type { TasteCodingRegistry, TasteViolation, TasteMetrics } from './taste-coding.js';
export { createTasteCodingRegistry } from './taste-coding.js';
