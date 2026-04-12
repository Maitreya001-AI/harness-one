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

function fail(path: string, reason: string, source: string): never {
  throw new HarnessError(
    `Corrupted ${source}: ${reason} at ${path}`,
    'STORE_CORRUPTION',
    'Inspect the backing store for manual edits, partial writes, or schema drift. ' +
      'If the data is recoverable, re-serialize it; otherwise delete the affected entry.',
  );
}

/** Validate shape of a MemoryEntry parsed from disk/network. */
export function validateMemoryEntry(v: unknown, source = 'memory entry'): MemoryEntry {
  if (!isObject(v)) fail('$', 'expected object', source);
  const o = v as Record<string, unknown>;

  if (typeof o.id !== 'string' || o.id.length === 0) fail('$.id', 'expected non-empty string', source);
  if (typeof o.key !== 'string') fail('$.key', 'expected string', source);
  if (typeof o.content !== 'string') fail('$.content', 'expected string', source);
  if (typeof o.grade !== 'string' || !GRADES.includes(o.grade as MemoryGrade)) {
    fail('$.grade', `expected one of [${GRADES.join(', ')}]`, source);
  }
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) {
    fail('$.createdAt', 'expected finite number', source);
  }
  if (typeof o.updatedAt !== 'number' || !Number.isFinite(o.updatedAt)) {
    fail('$.updatedAt', 'expected finite number', source);
  }
  if (o.metadata !== undefined && !isObject(o.metadata)) {
    fail('$.metadata', 'expected object or undefined', source);
  }
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags)) fail('$.tags', 'expected array or undefined', source);
    for (let i = 0; i < o.tags.length; i++) {
      if (typeof o.tags[i] !== 'string') fail(`$.tags[${i}]`, 'expected string', source);
    }
  }
  return o as unknown as MemoryEntry;
}

/** Validate shape of an Index file. */
export function validateIndex(v: unknown): Index {
  if (!isObject(v)) fail('$', 'expected object', 'memory index');
  const o = v as Record<string, unknown>;
  if (!isObject(o.keys)) fail('$.keys', 'expected object', 'memory index');
  const keys = o.keys as Record<string, unknown>;
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
  const o = v as Record<string, unknown>;
  if (!isObject(o.progress)) fail('$.progress', 'expected object', 'relay state');
  if (!Array.isArray(o.artifacts)) fail('$.artifacts', 'expected array', 'relay state');
  for (let i = 0; i < o.artifacts.length; i++) {
    if (typeof o.artifacts[i] !== 'string') fail(`$.artifacts[${i}]`, 'expected string', 'relay state');
  }
  if (typeof o.checkpoint !== 'string') fail('$.checkpoint', 'expected string', 'relay state');
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    fail('$.timestamp', 'expected finite number', 'relay state');
  }
  if (o._version !== undefined && (typeof o._version !== 'number' || !Number.isFinite(o._version))) {
    fail('$._version', 'expected finite number or undefined', 'relay state');
  }
  return o as unknown as RelayState & { _version?: number };
}

/** Safe JSON.parse wrapper: returns `{ ok: true, value }` or `{ ok: false, error }`. */
export function parseJsonSafe(raw: string): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
