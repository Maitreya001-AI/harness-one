/**
 * Types for the eval module — evaluation cases, results, scorers, and configs.
 *
 * @module
 */

/**
 * A single evaluation case.
 *
 * @example
 * ```ts
 * const evalCase: EvalCase = {
 *   id: 'case-1',
 *   input: 'What is 2+2?',
 *   expectedOutput: '4',
 * };
 * ```
 */
export interface EvalCase {
  readonly id: string;
  readonly input: string;
  readonly expectedOutput?: string;
  readonly context?: string;
  readonly tags?: string[];
  readonly metadata?: Record<string, unknown>;
}

/** Result of evaluating a single case. */
export interface EvalResult {
  readonly caseId: string;
  readonly scores: Record<string, number>;
  readonly passed: boolean;
  readonly details: Record<string, string>;
  readonly duration: number;
}

/** Aggregated evaluation report across all cases. */
export interface EvalReport {
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly passRate: number;
  readonly averageScores: Record<string, number>;
  readonly results: EvalResult[];
  readonly duration: number;
  readonly timestamp: number;
}

/** A scorer that evaluates output quality on a 0–1 scale. */
export interface Scorer {
  readonly name: string;
  readonly description: string;
  score(input: string, output: string, context?: string): Promise<{ score: number; explanation: string }>;
  /** Optional: Score multiple cases efficiently (e.g., batch LLM call). */
  scoreBatch?(cases: Array<{ input: string; output: string; context?: string }>): Promise<Array<{ score: number; explanation: string }>>;
}

/** Configuration for an eval runner. */
export interface EvalConfig {
  readonly scorers: Scorer[];
  readonly passThreshold?: number;
  readonly overallPassRate?: number;
  /** Max number of cases to run concurrently. Defaults to 1 (sequential). */
  readonly concurrency?: number;
}

/** Configuration for a generator-evaluator loop. */
export interface GeneratorEvaluatorConfig {
  readonly generate: (input: string) => Promise<string>;
  readonly evaluate: (input: string, output: string) => Promise<{ pass: boolean; feedback: string }>;
  readonly maxRetries?: number;
}
