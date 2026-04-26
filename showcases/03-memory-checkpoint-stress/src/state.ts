/**
 * Per-iteration mock work that the child process performs and persists
 * via `FsMemoryStore`. The state shape is intentionally trivial — the
 * showcase is about the persistence layer, not the simulated agent.
 */

export interface IterationState {
  readonly iteration: number;
  readonly checksum: string;
  readonly payloadKb: number;
  readonly timestampMs: number;
}

export const STATE_KEY_PREFIX = 'iter';

export function stateKey(iter: number): string {
  return `${STATE_KEY_PREFIX}-${String(iter).padStart(4, '0')}`;
}

/** Cheap deterministic checksum so we can detect round-trip corruption. */
export function checksum(iter: number): string {
  // Don't use crypto for "speed" — the showcase needs to run fast and
  // deterministically without pulling node:crypto.
  let h = 0;
  const s = `iter=${iter},seed=stress-showcase`;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
