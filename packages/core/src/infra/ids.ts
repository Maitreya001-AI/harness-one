/**
 * Cryptographically secure identifier generation.
 *
 * All harness-one modules that mint identifiers for externally reachable
 * resources (session IDs, trace/span IDs, memory-entry IDs) MUST use these
 * helpers rather than `Math.random()` or sequential counters. Weak identifiers
 * enable session-hijacking and enumeration attacks.
 *
 * @module
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { SessionId, SpanId, TraceId } from './brands.js';

/**
 * Brand a string as a {@link TraceId}. Trivial zero-cost cast at runtime;
 * the brand is phantom. Use at the call site that *creates* a trace id so
 * the rest of the codebase can reason about the branded type.
 */
export function asTraceId(id: string): TraceId {
  return id as TraceId;
}

/** Brand a string as a {@link SpanId}. See {@link asTraceId}. */
export function asSpanId(id: string): SpanId {
  return id as SpanId;
}

/** Brand a string as a {@link SessionId}. See {@link asTraceId}. */
export function asSessionId(id: string): SessionId {
  return id as SessionId;
}

/**
 * 128-bit random identifier as a 32-character hex string.
 * Suitable as the core of any externally reachable ID.
 */
export function secureId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Short 64-bit hex identifier (16 chars). Still has ~64 bits of entropy,
 * sufficient for in-process keys but not for externally exposed tokens.
 * Prefer `secureId()` for anything reachable by another tenant.
 */
export function shortSecureId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * RFC-4122 v4 UUID. Re-exported for callers that need the canonical format.
 */
export function uuid(): string {
  return randomUUID();
}

/**
 * Prefixed secure ID helper: `prefix-<hex>`. Useful for debug tracing where
 * the prefix identifies resource type (e.g., `sess-...`, `trace-...`).
 */
export function prefixedSecureId(prefix: string): string {
  return `${prefix}-${secureId()}`;
}
