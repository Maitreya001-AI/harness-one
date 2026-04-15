/**
 * Types for the devkit evolve surface — component metadata, drift detection,
 * taste-coding.
 *
 * Architecture rule types (`ArchitectureRule`, `RuleContext`, `RuleResult`)
 * moved to `harness-one/evolve-check` along with the checker implementation.
 *
 * @module
 */

/**
 * Metadata for a registered component.
 *
 * @example
 * ```ts
 * const meta: ComponentMeta = {
 *   id: 'ctx-packer',
 *   name: 'Context Packer',
 *   description: 'Packs messages into context window',
 *   modelAssumption: 'Models have limited context windows',
 *   retirementCondition: 'When models have unlimited context',
 *   createdAt: '2025-01-01',
 * };
 * ```
 */
export interface ComponentMeta {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly modelAssumption: string;
  readonly retirementCondition: string | ((context: Record<string, unknown>) => boolean);
  readonly createdAt: string;
  readonly lastValidated?: string;
  readonly tags?: string[];
}

/** A report on drift between baseline and current state. */
export interface DriftReport {
  readonly componentId: string;
  readonly driftDetected: boolean;
  readonly baseline: Record<string, unknown>;
  readonly current: Record<string, unknown>;
  readonly deviations: DriftDeviation[];
  readonly timestamp: number;
}

/** A single deviation found during drift detection. */
export interface DriftDeviation {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly severity: 'low' | 'medium' | 'high';
}

/** A taste-coding rule derived from an incident or PR. */
export interface TasteCodingRule {
  readonly id: string;
  readonly pattern: string;
  readonly rule: string;
  readonly enforcement: 'lint' | 'ci' | 'manual';
  readonly createdFrom: string;
  readonly createdAt: string;
}
