/**
 * Public barrel for the coding-agent guardrail layer.
 *
 * @module
 */

export {
  DEFAULT_COMMAND_ALLOWLIST,
  DEFAULT_COMMAND_DENY_PATTERNS,
  HARD_DENIED_COMMANDS,
  evaluateCommandPolicy,
} from './allowlist.js';

export {
  createCodingGuardrails,
  createDangerousCommandTextGuardrail,
  createSecretPathScrubGuardrail,
} from './policy.js';

export { createAuditor, fingerprintRequest } from './auditor.js';
export type { Auditor, AuditorOptions } from './auditor.js';
