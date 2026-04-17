/**
 * Readonly view builders for trace + span snapshots.
 *
 * Extracted from `trace-manager.ts` so the manager body does not
 * interleave "present the trace to an exporter" with "manage trace
 * lifecycle." Pure functions — no closure state, no side effects.
 *
 * @module
 */

import type { Span, SpanEvent, Trace } from './types.js';

/** Minimal shape of a mutable span that this helper can snapshot. */
export interface ViewableMutableSpan {
  readonly id: string;
  readonly traceId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly attributes: Record<string, unknown>;
  readonly events: readonly SpanEvent[];
  readonly status: 'running' | 'completed' | 'error';
}

/** Minimal shape of a mutable trace that this helper can snapshot. */
export interface ViewableMutableTrace {
  readonly id: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly userMetadata: Record<string, unknown>;
  readonly systemMetadata: Record<string, unknown>;
  readonly spanIds: readonly string[];
  readonly status: 'running' | 'completed' | 'error';
}

/**
 * Build a `Trace` snapshot with embedded span snapshots. `metadata`
 * preserves back-compat: callers reading `.metadata` see the user
 * metadata; when system metadata is present, it is exposed under the
 * `__system__` namespaced key so legacy observers still see it
 * without colliding with user keys.
 */
export function toReadonlyTrace(
  mt: ViewableMutableTrace,
  lookupSpan: (id: string) => ViewableMutableSpan | undefined,
): Trace {
  const traceSpans: Span[] = mt.spanIds
    .map((sid) => {
      const s = lookupSpan(sid);
      if (!s) return null;
      return {
        id: s.id,
        traceId: s.traceId,
        ...(s.parentId !== undefined && { parentId: s.parentId }),
        name: s.name,
        startTime: s.startTime,
        ...(s.endTime !== undefined && { endTime: s.endTime }),
        attributes: s.attributes,
        events: [...s.events],
        status: s.status,
      } as Span;
    })
    .filter((s): s is Span => s !== null);

  const combinedMetadata: Record<string, unknown> = { ...mt.userMetadata };
  if (Object.keys(mt.systemMetadata).length > 0) {
    combinedMetadata.__system__ = { ...mt.systemMetadata };
  }

  const result: Trace & {
    readonly userMetadata?: Record<string, unknown>;
    readonly systemMetadata?: Record<string, unknown>;
  } = {
    id: mt.id,
    name: mt.name,
    startTime: mt.startTime,
    ...(mt.endTime !== undefined && { endTime: mt.endTime }),
    metadata: combinedMetadata,
    userMetadata: { ...mt.userMetadata },
    systemMetadata: { ...mt.systemMetadata },
    spans: traceSpans,
    status: mt.status,
  };
  return result;
}
