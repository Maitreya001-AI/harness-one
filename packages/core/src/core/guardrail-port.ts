/**
 * Guardrail pipeline port — the runtime contract that the core agent loop
 * calls into without pulling the guardrails module at runtime.
 *
 * `GuardrailPipeline` is an opaque token carrying the four run-methods used
 * by the loop. The guardrails package returns an object satisfying this port
 * from `createPipeline()`. Core depends only on this port so that the
 * feature-level dependency rule ("features don't import features at
 * runtime") is not violated by the loop → guardrails edge.
 *
 * The shared value-types (Verdict / Context / Event / Result) also live here
 * so that guardrails, core and downstream consumers agree on a single
 * definition; `guardrails/types.ts` re-exports these.
 *
 * @module
 */

/** Verdict returned by a guardrail after evaluating content. */
export type GuardrailVerdict =
  | { action: 'allow'; reason?: string }
  | { action: 'block'; reason: string }
  | { action: 'modify'; modified: string; reason: string };

/** Permission level tiers for guardrail evaluation. */
export type PermissionLevel = 'strict' | 'default' | 'permissive';

/**
 * Direction tag denoting which pipeline phase produced this context.
 * Auto-filled by `runInput` / `runOutput` / `runToolOutput` /
 * `runRagContext` so guardrails can branch without the caller wiring
 * the value. Closes HARNESS_LOG research-collab L-002.
 */
export type GuardrailDirection = 'input' | 'output' | 'tool_output' | 'rag';

/** Context passed to a guardrail for evaluation. */
export interface GuardrailContext {
  content: string;
  meta?: Record<string, unknown>;
  permissionLevel?: PermissionLevel;
  /**
   * Pipeline-side direction tag (input/output/tool_output/rag). Filled
   * automatically by the pipeline before each guardrail runs; user
   * code that constructs a `GuardrailContext` directly may also set
   * it. First-class field so guardrails can branch on it without
   * digging into `meta`. Closes HARNESS_LOG research-collab L-002.
   */
  direction?: GuardrailDirection;
  /**
   * Free-form provenance tag — typically the URL / file / tool name
   * that produced `content`. Surfaces into trace exporters via the
   * pipeline's GuardrailEvent.
   */
  source?: string;
}

/** A guardrail function that evaluates content and returns a verdict. */
export type Guardrail = (ctx: GuardrailContext) => Promise<GuardrailVerdict> | GuardrailVerdict;

/**
 * Narrower alias for guardrails that always return synchronously.
 * Use this in factory return types (e.g. `createInjectionDetector():
 * SyncGuardrail`) so callers can call them without the
 * `instanceof Promise` narrowing dance. The pipeline still accepts
 * the union {@link Guardrail} for both sync and async guards.
 *
 * Closes HARNESS_LOG research-collab L-003.
 */
export type SyncGuardrail = (ctx: GuardrailContext) => GuardrailVerdict;

/**
 * Narrower alias for guardrails that always return a Promise. Counterpart
 * to {@link SyncGuardrail}; the pipeline still accepts {@link Guardrail}.
 */
export type AsyncGuardrail = (ctx: GuardrailContext) => Promise<GuardrailVerdict>;

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

/**
 * Opaque port handed to the agent loop. Obtained from
 * `@harness-one/guardrails`' `createPipeline()`. The `_brand` field keeps
 * the type nominal; the four methods are what the loop actually calls.
 *
 * Callers outside the loop can still use the module-level `runInput` /
 * `runOutput` / `runToolOutput` / `runRagContext` wrappers exported from
 * the guardrails module — those delegate to these methods.
 */
export interface GuardrailPipeline {
  readonly _brand: unique symbol;
  runInput(ctx: GuardrailContext): Promise<PipelineResult>;
  runOutput(ctx: GuardrailContext): Promise<PipelineResult>;
  runToolOutput(toolResult: string, toolName?: string): Promise<PipelineResult>;
  runRagContext(
    chunks: readonly string[],
    meta?: GuardrailContext['meta'],
  ): Promise<PipelineResult>;
}
