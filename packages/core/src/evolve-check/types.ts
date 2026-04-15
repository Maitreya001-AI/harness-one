/**
 * Types for architecture rule checking (core `evolve-check` subpath).
 *
 * This is a narrow, self-contained subset of the former `evolve/types.ts` that
 * only covers what `architecture-checker.ts` needs. The broader evolve types
 * (ComponentMeta, DriftReport, TasteCodingRule, …) now live in
 * `@harness-one/devkit`.
 *
 * @module
 */

/** A rule that checks architectural constraints. */
export interface ArchitectureRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly check: (context: RuleContext) => RuleResult;
}

/** Context provided to architecture rule checks. */
export interface RuleContext {
  readonly files: string[];
  readonly imports: Record<string, string[]>;
}

/** Result of an architecture rule check. */
export interface RuleResult {
  readonly passed: boolean;
  readonly violations: Array<{
    file: string;
    message: string;
    suggestion: string;
  }>;
}
