/**
 * Evolve module — component registry, drift detection, taste-coding.
 *
 * The architecture checker moved to `harness-one/evolve-check` (still in core)
 * because it is a runtime safety concern, not a dev-time tool.
 *
 * @module
 */

// Types (architecture rule types now come from harness-one/evolve-check)
export type {
  ComponentMeta,
  DriftReport,
  DriftDeviation,
  TasteCodingRule,
} from './types.js';

// Component registry
export type { ComponentRegistry } from './component-registry.js';
export { createComponentRegistry } from './component-registry.js';

// Drift detector
export type { DriftDetector, DriftDetectorConfig } from './drift-detector.js';
export { createDriftDetector } from './drift-detector.js';

// Taste-coding
export type { TasteCodingRegistry, TasteViolation, TasteMetrics } from './taste-coding.js';
export { createTasteCodingRegistry } from './taste-coding.js';
