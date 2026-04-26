/**
 * Dataset exporter — converts execution traces into fine-tuning datasets.
 *
 * Produces JSONL (one JSON object per line) from TraceManager trace data,
 * filtering by model, quality, and tool-call inclusion.
 *
 * @module
 */

import type { Trace, Span } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single fine-tuning dataset entry derived from an LLM call span. */
export interface DatasetEntry {
  /** Input messages to the LLM. */
  messages: Array<{ role: string; content: string }>;
  /** Expected/actual output. */
  output: {
    role: string;
    content: string;
    toolCalls?: Array<{ name: string; arguments: string }>;
  };
  /** Metadata for filtering. */
  metadata: {
    traceId: string;
    spanId: string;
    model?: string;
    tokenUsage?: { inputTokens: number; outputTokens: number };
    cost?: number;
    latencyMs?: number;
  };
}

/** Configuration for the dataset exporter. */
export interface DatasetExporterConfig {
  /** Minimum quality score to include (0-1). Spans without a score are included. */
  minQuality?: number;
  /** Filter by model name. */
  model?: string;
  /** Include tool call interactions in the output. Default: false. */
  includeToolCalls?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a span represents an LLM call by checking for the
 * `llm.input_messages` attribute.
 */
function isLlmSpan(span: Span): boolean {
  const attrs = span.attributes ?? {};
  return Array.isArray(attrs['llm.input_messages']);
}

/**
 * Check whether a span passes all configured filters.
 */
function passesFilters(
  span: Span,
  config: { minQuality?: number; model?: string },
): boolean {
  // Only completed spans are eligible for the dataset
  if (span.status !== 'completed') {
    return false;
  }

  // Must be an LLM call
  if (!isLlmSpan(span)) {
    return false;
  }

  const attrs = span.attributes ?? {};

  // Model filter
  if (config.model !== undefined) {
    const spanModel = attrs['llm.model'];
    if (spanModel !== config.model) {
      return false;
    }
  }

  // Quality filter — spans without a quality score are included
  if (config.minQuality !== undefined) {
    const quality = attrs['llm.quality_score'];
    if (typeof quality === 'number' && quality < config.minQuality) {
      return false;
    }
  }

  return true;
}

/**
 * Convert a single span into a DatasetEntry.
 */
function spanToEntry(span: Span, includeToolCalls: boolean): DatasetEntry | undefined {
  const attrs = span.attributes ?? {};
  const rawInput = attrs['llm.input_messages'];
  const rawOutput = attrs['llm.output_message'];
  if (!Array.isArray(rawInput) || typeof rawOutput !== 'object' || rawOutput === null) {
    return undefined;
  }
  const inputMessages = rawInput as Array<{
    role: string;
    content: string;
  }>;

  const outputMessage = rawOutput as {
    role: string;
    content: string;
    toolCalls?: Array<{ name: string; arguments: string }>;
  };

  const model = attrs['llm.model'] as string | undefined;
  const tokenUsage = attrs['llm.token_usage'] as
    | { inputTokens: number; outputTokens: number }
    | undefined;
  const cost = attrs['llm.cost'] as number | undefined;

  const latencyMs =
    span.endTime !== undefined ? span.endTime - span.startTime : undefined;

  // Build the output, conditionally including tool calls
  const output: DatasetEntry['output'] = {
    role: outputMessage.role,
    content: outputMessage.content,
  };

  if (includeToolCalls && outputMessage.toolCalls) {
    output.toolCalls = outputMessage.toolCalls;
  }

  return {
    messages: inputMessages.map((m) => ({ role: m.role, content: m.content })),
    output,
    metadata: {
      traceId: span.traceId,
      spanId: span.id,
      ...(model !== undefined && { model }),
      ...(tokenUsage !== undefined && { tokenUsage }),
      ...(cost !== undefined && { cost }),
      ...(latencyMs !== undefined && { latencyMs }),
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a dataset exporter that converts traces into fine-tuning datasets.
 *
 * @example
 * ```ts
 * const exporter = createDatasetExporter({ model: 'gpt-4', minQuality: 0.8 });
 * const jsonl = exporter.exportToJsonl(traces);
 * ```
 */
export function createDatasetExporter(config?: DatasetExporterConfig): {
  /** Export traces to JSONL string. */
  exportToJsonl(traces: Trace[]): string;
  /** Export traces to an array of DatasetEntry. */
  exportToEntries(traces: Trace[]): DatasetEntry[];
} {
  const minQuality = config?.minQuality;
  const model = config?.model;
  const includeToolCalls = config?.includeToolCalls ?? false;

  return {
    exportToEntries(traces: Trace[]): DatasetEntry[] {
      const entries: DatasetEntry[] = [];

      const filterConfig = {
        ...(minQuality !== undefined ? { minQuality } : {}),
        ...(model !== undefined ? { model } : {}),
      };

      for (const trace of traces) {
        for (const span of trace.spans) {
          if (passesFilters(span, filterConfig)) {
            const entry = spanToEntry(span, includeToolCalls);
            if (entry !== undefined) {
              entries.push(entry);
            }
          }
        }
      }

      return entries;
    },

    exportToJsonl(traces: Trace[]): string {
      const entries = this.exportToEntries(traces);
      if (entries.length === 0) {
        return '';
      }
      return entries.map((entry) => JSON.stringify(entry)).join('\n');
    },
  };
}
