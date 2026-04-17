/**
 * Safe cross-agent payload serialization.
 *
 * Centralizes the depth + byte-size caps that were historically inlined in
 * `handoff.ts` (and could easily have diverged with a future context-boundary
 * event stream). Both call sites that move untrusted data across an agent
 * boundary should use this module rather than re-implementing the guard.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';

/** Default maximum serialised payload size in bytes (64 KiB). */
export const DEFAULT_PAYLOAD_MAX_BYTES = 64 * 1024;
/** Default maximum nested depth of a payload (16 levels). */
export const DEFAULT_PAYLOAD_MAX_DEPTH = 16;

/** Options accepted by {@link serializePayloadSafe}. */
export interface SafePayloadOptions {
  /** Byte cap on the JSON-serialised form. Default {@link DEFAULT_PAYLOAD_MAX_BYTES}. */
  readonly maxBytes?: number;
  /** Depth cap checked before JSON.stringify runs. Default {@link DEFAULT_PAYLOAD_MAX_DEPTH}. */
  readonly maxDepth?: number;
  /**
   * Error code used for every failure raised from this module. Callers pick
   * the code that matches their domain (e.g. `ORCH_HANDOFF_SERIALIZATION_ERROR`).
   */
  readonly errorCode: HarnessErrorCode;
}

/**
 * Walk a value checking that nested depth never exceeds `maxDepth`. Throws
 * `HarnessError(options.errorCode)` with a diagnostic path when the cap is
 * breached. Used to guard against pathological recursive objects before
 * JSON.stringify runs — otherwise a deep object would exhaust the call stack.
 */
export function checkPayloadDepth(
  value: unknown,
  options: { readonly maxDepth: number; readonly errorCode: HarnessErrorCode },
): void {
  walk(value, 0, '$', options.maxDepth, options.errorCode);
}

function walk(
  value: unknown,
  depth: number,
  path: string,
  maxDepth: number,
  errorCode: HarnessErrorCode,
): void {
  if (depth > maxDepth) {
    throw new HarnessError(
      `Failed to serialize payload: depth exceeds ${maxDepth} at ${path}`,
      errorCode,
      'Flatten nested structures before sending',
    );
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], depth + 1, `${path}[${i}]`, maxDepth, errorCode);
    }
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    walk(v, depth + 1, `${path}.${k}`, maxDepth, errorCode);
  }
}

/**
 * Serialise `payload` with the depth + byte caps enforced. Returns the JSON
 * body on success; throws `HarnessError(options.errorCode)` on any failure
 * (depth cap, stringify throws, byte cap).
 */
export function serializePayloadSafe(
  payload: unknown,
  options: SafePayloadOptions,
): string {
  const maxDepth = options.maxDepth ?? DEFAULT_PAYLOAD_MAX_DEPTH;
  const maxBytes = options.maxBytes ?? DEFAULT_PAYLOAD_MAX_BYTES;
  checkPayloadDepth(payload, { maxDepth, errorCode: options.errorCode });

  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch (err) {
    throw new HarnessError(
      `Failed to serialize payload: ${err instanceof Error ? err.message : String(err)}`,
      options.errorCode,
      'Ensure all values in the payload are JSON-serializable',
    );
  }

  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > maxBytes) {
    throw new HarnessError(
      `Payload is ${bytes} bytes; exceeds cap of ${maxBytes}`,
      options.errorCode,
      'Reduce payload size or reference large data via a handle instead',
    );
  }
  return body;
}
