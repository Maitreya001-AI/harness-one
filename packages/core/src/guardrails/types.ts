/**
 * Re-exports of the guardrail value types.
 *
 * The authoritative definitions live in `core/guardrail-port.ts` so that the
 * agent loop can depend on them without creating a runtime edge into the
 * guardrails feature module. This file keeps the long-standing
 * `guardrails/types.js` path valid for internal and downstream consumers.
 *
 * @module
 */

export type {
  GuardrailVerdict,
  PermissionLevel,
  GuardrailContext,
  GuardrailDirection,
  Guardrail,
  SyncGuardrail,
  AsyncGuardrail,
  GuardrailEvent,
  PipelineResult,
} from '../core/guardrail-port.js';
