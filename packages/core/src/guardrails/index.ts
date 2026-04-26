/**
 * Guardrails module — pipeline, guardrail retry, and built-in guardrails.
 *
 * @module
 */

// Types
export type {
  GuardrailVerdict,
  GuardrailContext,
  GuardrailDirection,
  Guardrail,
  SyncGuardrail,
  AsyncGuardrail,
  GuardrailEvent,
  PipelineResult,
  PermissionLevel,
} from './types.js';

// `getRejectionReason` helper closes the showcase 02 friction
// (verbose `'reason' in verdict.verdict ? ...` pattern at every call site).
export { getRejectionReason } from './pipeline.js';

// Pipeline
export { createPipeline, runInput, runOutput, runToolOutput, runRagContext } from './pipeline.js';
export type { GuardrailPipeline } from './pipeline.js';

// Guardrail retry
export { withGuardrailRetry } from './self-healing.js';

// Built-in guardrails
export { createRateLimiter } from './rate-limiter.js';
export { createInjectionDetector } from './injection-detector.js';
export { createSchemaValidator } from './schema-validator.js';
export { createContentFilter } from './content-filter.js';
export { createPIIDetector } from './pii-detector.js';
