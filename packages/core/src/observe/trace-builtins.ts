/**
 * Built-in {@link TraceExporter} helpers + the shared error-sanitiser for
 * exporter boundaries. Separated from the trace-manager implementation
 * because none of these touch trace/span state — they're pure utilities
 * that downstream adapters (OTel, Langfuse) also consume.
 *
 * @module
 */

import type { Span, Trace, TraceExporter } from './types.js';

/**
 * Console-logging {@link TraceExporter}. Intended for local development and
 * tests, not for production — every span/trace goes through `console.log`
 * (or the injected `output` sink).
 *
 * @example
 * ```ts
 * const exporter = createConsoleExporter({ verbose: true });
 * const tm = createTraceManager({ exporters: [exporter] });
 * ```
 */
export function createConsoleExporter(config?: {
  verbose?: boolean;
  output?: (line: string) => void;
}): TraceExporter {
  const verbose = config?.verbose ?? false;
  // eslint-disable-next-line no-console
  const output = config?.output ?? console.log;
  return {
    name: 'console',
    async exportTrace(trace: Trace): Promise<void> {
      if (verbose) {
        output(`[trace] ${JSON.stringify(trace, null, 2)}`);
      } else {
        output(`[trace] ${trace.name} (${trace.status}) ${trace.spans.length} spans`);
      }
    },
    async exportSpan(span: Span): Promise<void> {
      if (verbose) {
        output(`[span] ${JSON.stringify(span, null, 2)}`);
      } else {
        output(`[span] ${span.name} (${span.status})`);
      }
    },
    async flush(): Promise<void> {
      // Nothing to flush for console
    },
  };
}

/**
 * No-op {@link TraceExporter}. Useful when tests need to satisfy the "at
 * least one exporter must be configured" invariant without observing any
 * side effects.
 *
 * @example
 * ```ts
 * const exporter = createNoOpExporter();
 * ```
 */
export function createNoOpExporter(): TraceExporter {
  return {
    name: 'noop',
    async exportTrace(): Promise<void> {},
    async exportSpan(): Promise<void> {},
    async flush(): Promise<void> {},
  };
}
