/**
 * Eval module — evaluation runners, scorers, generator-evaluator, and data flywheel.
 *
 * @module
 */

// Types
export type {
  EvalCase,
  EvalResult,
  EvalReport,
  Scorer,
  EvalConfig,
  GeneratorEvaluatorConfig,
} from './types.js';

// Runner
export type { EvalRunner } from './runner.js';
export { createEvalRunner } from './runner.js';

// Scorers
export {
  createRelevanceScorer,
  createFaithfulnessScorer,
  createLengthScorer,
  createCustomScorer,
} from './scorers.js';

// Generator-Evaluator
export { runGeneratorEvaluator } from './generator-evaluator.js';

// Flywheel
export type { FlywheelConfig } from './flywheel.js';
export { extractNewCases } from './flywheel.js';
