/**
 * Runtime schema validation for memory persistence boundaries.
 *
 * Every disk/network byte is potentially corrupt: an interrupted write, a
 * manual edit, a version migration, or a bit flip on aging media. Casting
 * `JSON.parse(...) as T` is a lie to the type system — this module replaces
 * those casts with hand-rolled guards that throw `STORE_CORRUPTION` with a
 * diagnostic path when the shape is wrong.
 *
 * We deliberately avoid a schema library dependency (zod/ajv) for the core
 * package — the types to validate here are small and stable.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type { MemoryEntry, MemoryGrade, RelayState } from './types.js';
import type { Index } from './fs-io.js';

const GRADES: readonly MemoryGrade[] = ['critical', 'useful', 'ephemeral'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * CQ-045: Type-guard for {@link MemoryEntry}. Returns `true` iff the value
 * matches the full shape of a memory entry, so TypeScript can narrow the
 * callsite without an `as unknown as` escape hatch.
 *
 * The guard is deliberately exhaustive — every field is checked at runtime
 * so an interrupted write or manual edit cannot slip past the boundary.
 */
export function isMemoryEntry(v: unknown): v is MemoryEntry {
  if (!isObject(v)) return false;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.key !== 'string') return false;
  if (typeof v.content !== 'string') return false;
  if (typeof v.grade !== 'string' || !GRADES.includes(v.grade as MemoryGrade)) return false;
  if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return false;
  if (typeof v.updatedAt !== 'number' || !Number.isFinite(v.updatedAt)) return false;
  if (v.metadata !== undefined && !isObject(v.metadata)) return false;
  if (v.tags !== undefined) {
    if (!Array.isArray(v.tags)) return false;
    for (let i = 0; i < v.tags.length; i++) {
      if (typeof v.tags[i] !== 'string') return false;
    }
  }
  return true;
}

/**
 * CQ-045: Type-guard for versioned {@link RelayState} blobs. See
 * {@link isMemoryEntry} — same rationale.
 */
export function isRelayState(v: unknown): v is RelayState & { _version?: number } {
  if (!isObject(v)) return false;
  if (!isObject(v.progress)) return false;
  if (!Array.isArray(v.artifacts)) return false;
  for (let i = 0; i < v.artifacts.length; i++) {
    if (typeof v.artifacts[i] !== 'string') return false;
  }
  if (typeof v.checkpoint !== 'string') return false;
  if (typeof v.timestamp !== 'number' || !Number.isFinite(v.timestamp)) return false;
  if (v._version !== undefined && (typeof v._version !== 'number' || !Number.isFinite(v._version))) {
    return false;
  }
  return true;
}

function fail(path: string, reason: string, source: string): never {
  // CQ-045: Tag these throws with `MEMORY_CORRUPT` so harness wrappers can
  // distinguish memory-persistence corruption from other
  // `STORE_CORRUPTION` sources via `.code`. The legacy `STORE_CORRUPTION`
  // code is still recognised by consumer error handlers — see errors.ts —
  // but the memory subsystem now emits `MEMORY_CORRUPT` specifically.
  throw new HarnessError(
    `Corrupted ${source}: ${reason} at ${path}`,
    'MEMORY_CORRUPT',
    'Inspect the backing store for manual edits, partial writes, or schema drift. ' +
      'If the data is recoverable, re-serialize it; otherwise delete the affected entry.',
  );
}

/** Validate shape of a MemoryEntry parsed from disk/network. */
export function validateMemoryEntry(v: unknown, source = 'memory entry'): MemoryEntry {
  if (!isObject(v)) fail('$', 'expected object', source);

  if (typeof v.id !== 'string' || v.id.length === 0) fail('$.id', 'expected non-empty string', source);
  if (typeof v.key !== 'string') fail('$.key', 'expected string', source);
  if (typeof v.content !== 'string') fail('$.content', 'expected string', source);
  if (typeof v.grade !== 'string' || !GRADES.includes(v.grade as MemoryGrade)) {
    fail('$.grade', `expected one of [${GRADES.join(', ')}]`, source);
  }
  if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) {
    fail('$.createdAt', 'expected finite number', source);
  }
  if (typeof v.updatedAt !== 'number' || !Number.isFinite(v.updatedAt)) {
    fail('$.updatedAt', 'expected finite number', source);
  }
  if (v.metadata !== undefined && !isObject(v.metadata)) {
    fail('$.metadata', 'expected object or undefined', source);
  }
  if (v.tags !== undefined) {
    if (!Array.isArray(v.tags)) fail('$.tags', 'expected array or undefined', source);
    for (let i = 0; i < v.tags.length; i++) {
      if (typeof v.tags[i] !== 'string') fail(`$.tags[${i}]`, 'expected string', source);
    }
  }
  // CQ-045: `isMemoryEntry` narrows `v` to `MemoryEntry` via the TS type
  // guard, replacing the old `as unknown as MemoryEntry` escape hatch. The
  // per-field checks above fail early with a precise JSON-path for
  // diagnostics; this final call is a belt-and-braces narrowing that also
  // guards against schema drift creeping ahead of the individual checks.
  if (!isMemoryEntry(v)) fail('$', 'failed full-shape guard', source);
  return v;
}

/** Validate shape of an Index file. */
export function validateIndex(v: unknown): Index {
  if (!isObject(v)) fail('$', 'expected object', 'memory index');
  if (!isObject(v.keys)) fail('$.keys', 'expected object', 'memory index');
  const keys = v.keys;
  for (const [k, id] of Object.entries(keys)) {
    if (typeof id !== 'string' || id.length === 0) {
      fail(`$.keys[${JSON.stringify(k)}]`, 'expected non-empty string id', 'memory index');
    }
  }
  return { keys: keys as Record<string, string> };
}

/** Validate shape of a versioned relay state blob parsed from entry.content. */
export function validateRelayState(v: unknown): RelayState & { _version?: number } {
  if (!isObject(v)) fail('$', 'expected object', 'relay state');
  if (!isObject(v.progress)) fail('$.progress', 'expected object', 'relay state');
  if (!Array.isArray(v.artifacts)) fail('$.artifacts', 'expected array', 'relay state');
  for (let i = 0; i < v.artifacts.length; i++) {
    if (typeof v.artifacts[i] !== 'string') fail(`$.artifacts[${i}]`, 'expected string', 'relay state');
  }
  if (typeof v.checkpoint !== 'string') fail('$.checkpoint', 'expected string', 'relay state');
  if (typeof v.timestamp !== 'number' || !Number.isFinite(v.timestamp)) {
    fail('$.timestamp', 'expected finite number', 'relay state');
  }
  if (v._version !== undefined && (typeof v._version !== 'number' || !Number.isFinite(v._version))) {
    fail('$._version', 'expected finite number or undefined', 'relay state');
  }
  // CQ-045: `isRelayState` narrows via the TS type guard, replacing the
  // previous `as unknown as RelayState` cast.
  if (!isRelayState(v)) fail('$', 'failed full-shape guard', 'relay state');
  return v;
}

/** Safe JSON.parse wrapper: returns `{ ok: true, value }` or `{ ok: false, error }`. */
export function parseJsonSafe(raw: string): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
