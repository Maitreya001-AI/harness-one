/**
 * Public barrel for the secret-redaction utilities. This is the
 * canonical path — prior releases re-exported the same symbols from
 * `harness-one/observe`, but that forced every adapter package to
 * depend on `observe` for a cross-cutting concern. Redaction is a
 * core-level primitive (used by Logger, TraceManager, exporters), so
 * it lives at its own subpath.
 *
 * Back-compat: the same names remain available via
 * `harness-one/observe` with `@deprecated` markers through the next
 * minor version; see MIGRATION.md for the removal schedule.
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
