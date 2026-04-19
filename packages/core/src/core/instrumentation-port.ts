/**
 * InstrumentationPort — minimal tracing contract for subsystems.
 *
 * The port lives in core/core (L2). RAG and other subsystems consume it
 * without coupling to the full {@link TraceManager} surface, and keeping
 * the port at L2 removes an L3→L3 edge (see docs/ARCHITECTURE.md).
 *
 * The harness-one `TraceManager` implements this interface structurally —
 * any existing `TraceManager` instance is a valid `InstrumentationPort`,
 * so no adapter is needed at the call site.
 *
 * @module
 */

/**
 * The minimum tracing surface required to instrument an operation: open a
 * span, attach key/value attributes, record timestamped events on the span,
 * and close the span.
 *
 * `traceId` is treated as opaque — implementations may use it as a parent
 * pointer, a logical group id, or ignore it entirely.
 */
export interface InstrumentationPort {
  /** Open a span. `parentId` is an optional parent span for nesting. */
  startSpan(traceId: string, name: string, parentId?: string): string;
  /** End a previously-opened span with an optional status. */
  endSpan(spanId: string, status?: 'completed' | 'error'): void;
  /** Attach a timestamped event to a span. */
  addSpanEvent(spanId: string, event: { name: string; attributes?: Record<string, unknown> }): void;
  /** Set / merge attributes on a span. */
  setSpanAttributes(spanId: string, attributes: Record<string, unknown>): void;
  /**
   * Optional: open a top-level trace (groups subsequent spans). Callers that
   * already have a trace context (e.g. RAG pipelines invoked from the
   * `AgentLoop`) can omit this and pass the existing `traceId` straight to
   * `startSpan`.
   */
  startTrace?(name: string, metadata?: Record<string, unknown>): string;
  /** Optional: close a top-level trace opened via `startTrace()`. */
  endTrace?(traceId: string, status?: 'completed' | 'error'): void;
}
