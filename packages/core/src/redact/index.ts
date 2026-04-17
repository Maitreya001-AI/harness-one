/**
 * Public barrel for the secret-redaction utilities — the canonical path.
 * Redaction is a core-level primitive (used by Logger, TraceManager,
 * exporters), so it lives at its own subpath rather than being bundled
 * into the observe surface.
 *
 * @module
 */

export type { RedactConfig, Redactor } from '../infra/redact.js';
export {
  createRedactor,
  redactValue,
  sanitizeAttributes,
  REDACTED_VALUE,
  DEFAULT_SECRET_PATTERN,
  POLLUTING_KEYS,
} from '../infra/redact.js';
