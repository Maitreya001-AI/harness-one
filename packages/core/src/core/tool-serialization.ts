/**
 * Defensive serialization for tool-call results.
 *
 * Extracted from `iteration-runner.ts` in round-3 cleanup — the runner only
 * calls {@link safeStringifyToolResult} on the happy path; the logic itself
 * has nothing to do with iteration choreography.
 *
 * Three orthogonal caps protect the downstream LLM from pathological payloads:
 *
 * 1. **Depth cap** ({@link MAX_TOOL_RESULT_DEPTH}) — stops unbounded recursion
 *    via a `WeakMap` that tracks each container's depth relative to the root.
 * 2. **Width cap** ({@link MAX_TOOL_RESULT_KEYS_PER_CONTAINER}) — truncates any
 *    single object/array whose key count exceeds the limit so a wide-but-shallow
 *    payload cannot balloon past the byte cap before truncation kicks in.
 * 3. **Byte cap** ({@link MAX_TOOL_RESULT_BYTES}) — final guard on the serialized
 *    string; oversized output is truncated with {@link TRUNCATION_MARKER}.
 *
 * Cycles are broken via a `WeakSet`, replaced with the `'[circular]'` sentinel.
 *
 * @module
 */

/** Maximum serialized tool result size (1 MiB). */
export const MAX_TOOL_RESULT_BYTES = 1 * 1024 * 1024;
/** Maximum object nesting depth for tool-result serialization. */
export const MAX_TOOL_RESULT_DEPTH = 10;
/**
 * Maximum number of keys (or array slots) per container.
 *
 * A wide-but-shallow object (e.g. 100k sibling keys at depth 1) would pass the
 * {@link MAX_TOOL_RESULT_DEPTH} check and only be caught by
 * {@link MAX_TOOL_RESULT_BYTES} AFTER full serialization — wasting CPU and
 * spiking memory before the truncation. The per-container width cap rejects
 * such containers during the walk itself.
 */
export const MAX_TOOL_RESULT_KEYS_PER_CONTAINER = 1000;
/**
 * Truncation marker appended when the serialized result exceeds
 * {@link MAX_TOOL_RESULT_BYTES}. Consumers/LLMs can detect the marker to know
 * the result was cut; the prefix of the payload is still useful context.
 */
export const TRUNCATION_MARKER = '...[truncated: result exceeded 1MiB]';
/** Sentinel written in place of a container whose width exceeded the cap. */
export const WIDTH_TRUNCATION_MARKER = '[truncated: container exceeded width cap]';

/**
 * Shallow-clone a container, keeping only the first
 * {@link MAX_TOOL_RESULT_KEYS_PER_CONTAINER} entries and appending a sentinel
 * so the LLM sees the truncation explicitly.
 */
function truncateContainer(value: object): object {
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_TOOL_RESULT_KEYS_PER_CONTAINER);
    return [...kept, WIDTH_TRUNCATION_MARKER];
  }
  const keys = Object.keys(value);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < MAX_TOOL_RESULT_KEYS_PER_CONTAINER; i++) {
    const k = keys[i];
    if (k === undefined) break;
    out[k] = (value as Record<string, unknown>)[k];
  }
  out['__truncated__'] = WIDTH_TRUNCATION_MARKER;
  return out;
}

/**
 * Depth-limited, cycle-safe, width-capped JSON serializer for tool results.
 *
 * Returns the serialized JSON string, or a sentinel message when the input
 * cannot be serialized at all. Never throws on user input — any internal
 * failure resolves to a sentinel so the agent loop can keep advancing.
 */
export function safeStringifyToolResult(value: unknown): string {
  const seen = new WeakSet<object>();
  /**
   * Map container object → its depth relative to the root. `undefined`
   * means "root" (not yet entered). Depth increments only when we descend
   * into a new container, not on sibling keys.
   */
  const depthMap = new WeakMap<object, number>();

  const replacer = function (this: unknown, _key: string, val: unknown): unknown {
    if (val === null || typeof val !== 'object') return val;
    if (seen.has(val as object)) return '[circular]';
    // Determine this value's depth: parent depth + 1 (or 0 if root).
    const parent = this as object | undefined;
    const parentDepth =
      parent !== undefined && depthMap.has(parent) ? depthMap.get(parent)! : -1;
    const nextDepth = parentDepth + 1;
    if (nextDepth > MAX_TOOL_RESULT_DEPTH) {
      // Returning undefined drops the key from the output; for an array
      // slot this produces `null`, which matches JSON.stringify's default
      // behaviour for dropped values in arrays.
      return undefined;
    }
    // Width cap: Arrays check .length; plain objects check own-key count.
    const widthExceeded = Array.isArray(val)
      ? val.length > MAX_TOOL_RESULT_KEYS_PER_CONTAINER
      : Object.keys(val as object).length > MAX_TOOL_RESULT_KEYS_PER_CONTAINER;
    if (widthExceeded) {
      const truncated = truncateContainer(val as object);
      seen.add(truncated);
      depthMap.set(truncated, nextDepth);
      return truncated;
    }
    seen.add(val as object);
    depthMap.set(val as object, nextDepth);
    return val;
  };

  let serialized: string;
  try {
    serialized = JSON.stringify(value, replacer);
  } catch {
    return '[Object could not be serialized]';
  }
  if (serialized === undefined) return '[result not serializable]';
  if (serialized.length > MAX_TOOL_RESULT_BYTES) {
    // Truncate with marker instead of discarding entirely. Subtract the
    // marker length so the final string stays within budget.
    return (
      serialized.slice(0, MAX_TOOL_RESULT_BYTES - TRUNCATION_MARKER.length) +
      TRUNCATION_MARKER
    );
  }
  return serialized;
}
