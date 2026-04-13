/**
 * Minimal tracing interface accepted by `AgentLoop` and other core
 * primitives.
 *
 * This interface lives in the `core` module — *not* in `observe` — so that
 * core code can describe its tracing dependency without importing the full
 * `TraceManager` implementation. The full
 * {@link import('../observe/trace-manager.js').TraceManager} is structurally
 * compatible with this interface, so consumers can pass a `TraceManager`
 * instance directly. Keeping the structural-compat boundary here (rather
 * than inline on `AgentLoop`) avoids a circular dependency between `core`
 * and `observe` while still letting downstream callers use either side.
 *
 * @module
 */

/**
 * Subset of the `TraceManager` API used by the `AgentLoop`. Implementations
 * are free to ignore any call (every method is invoked optionally guarded by
 * a `if (tm)` check in callers) — most consumers will simply pass a real
 * {@link import('../observe/trace-manager.js').TraceManager}.
 */
export interface AgentLoopTraceManager {
  startTrace(name: string, metadata?: Record<string, unknown>): string;
  startSpan(traceId: string, name: string, parentId?: string): string;
  setSpanAttributes(spanId: string, attributes: Record<string, unknown>): void;
  /**
   * Record a timestamped event within a span — used by AgentLoop to record
   * adapter retries and other diagnostic markers without creating child spans.
   */
  addSpanEvent(spanId: string, event: { name: string; attributes?: Record<string, unknown> }): void;
  endSpan(spanId: string, status?: 'completed' | 'error'): void;
  endTrace(traceId: string, status?: 'completed' | 'error'): void;
}
