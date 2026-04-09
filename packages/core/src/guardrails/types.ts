/**
 * Types for the guardrails module.
 *
 * @module
 */

/** Verdict returned by a guardrail after evaluating content. */
export type GuardrailVerdict =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'modify'; modified: string; reason: string };

/** Permission level tiers for guardrail evaluation. */
export type PermissionLevel = 'strict' | 'default' | 'permissive';

/** Context passed to a guardrail for evaluation. */
export interface GuardrailContext {
  content: string;
  meta?: Record<string, unknown>;
  permissionLevel?: PermissionLevel;
}

/** A guardrail function that evaluates content and returns a verdict. */
export type Guardrail = (ctx: GuardrailContext) => Promise<GuardrailVerdict> | GuardrailVerdict;

/** Event emitted when a guardrail runs. */
export interface GuardrailEvent {
  guardrail: string;
  direction: 'input' | 'output';
  verdict: GuardrailVerdict;
  latencyMs: number;
}

/** Result of running a guardrail pipeline. */
export interface PipelineResult {
  passed: boolean;
  verdict: GuardrailVerdict;
  results: GuardrailEvent[];
  /** Final content after all modify verdicts have been applied. */
  modifiedContent?: string;
}
