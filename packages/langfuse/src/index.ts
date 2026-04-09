/**
 * @harness-one/langfuse — Langfuse integration for harness-one.
 *
 * Provides trace export, prompt management, and cost tracking via Langfuse.
 *
 * @module
 */

import type { Langfuse } from 'langfuse';
import type { TraceExporter, Trace, Span } from 'harness-one/observe';
import type { PromptBackend, PromptTemplate } from 'harness-one/prompt';
import type { CostTracker, ModelPricing } from 'harness-one/observe';
import type { TokenUsageRecord, CostAlert } from 'harness-one/observe';
import { HarnessError } from 'harness-one/core';

// ---------------------------------------------------------------------------
// TraceExporter
// ---------------------------------------------------------------------------

/** Configuration for the Langfuse trace exporter. */
export interface LangfuseExporterConfig {
  /** A pre-configured Langfuse client instance. */
  readonly client: Langfuse;
  /** Optional: sanitize span attributes before export (e.g., strip PII). */
  readonly sanitize?: (attributes: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Create a TraceExporter that sends traces and spans to Langfuse.
 *
 * - Traces map to Langfuse traces.
 * - Spans with LLM attributes (model, inputTokens) map to Langfuse generations.
 * - Other spans map to generic Langfuse spans.
 */
export function createLangfuseExporter(config: LangfuseExporterConfig): TraceExporter {
  const { client } = config;

  // Track Langfuse trace objects so spans can attach to the correct parent.
  const MAX_TRACE_MAP_SIZE = 1000;
  const traceMap = new Map<string, ReturnType<typeof client.trace>>();

  return {
    name: 'langfuse',

    async exportTrace(trace: Trace): Promise<void> {
      let lfTrace = traceMap.get(trace.id);
      if (!lfTrace) {
        lfTrace = client.trace({
          id: trace.id,
          name: trace.name,
          metadata: trace.metadata,
        });
        traceMap.set(trace.id, lfTrace);
        if (traceMap.size > MAX_TRACE_MAP_SIZE) {
          const evictCount = Math.ceil(MAX_TRACE_MAP_SIZE * 0.1);
          const keys = traceMap.keys();
          for (let i = 0; i < evictCount; i++) {
            const key = keys.next().value;
            if (key !== undefined) traceMap.delete(key);
          }
        }
      }

      lfTrace.update({
        metadata: {
          ...trace.metadata,
          status: trace.status,
          spanCount: trace.spans.length,
        },
      });
    },

    async exportSpan(span: Span): Promise<void> {
      let lfTrace = traceMap.get(span.traceId);
      if (!lfTrace) {
        lfTrace = client.trace({ id: span.traceId, name: 'unknown' });
        traceMap.set(span.traceId, lfTrace);
        if (traceMap.size > MAX_TRACE_MAP_SIZE) {
          const evictCount = Math.ceil(MAX_TRACE_MAP_SIZE * 0.1);
          const keys = traceMap.keys();
          for (let i = 0; i < evictCount; i++) {
            const key = keys.next().value;
            if (key !== undefined) traceMap.delete(key);
          }
        }
      }

      const attrs = config.sanitize ? config.sanitize(span.attributes) : span.attributes;

      const isGeneration =
        attrs['harness.span.kind'] === 'generation' ||
        attrs['model'] !== undefined ||
        (attrs['inputTokens'] !== undefined && attrs['outputTokens'] !== undefined);

      if (isGeneration) {
        lfTrace.generation({
          name: span.name,
          startTime: new Date(span.startTime),
          ...(span.endTime !== undefined && { endTime: new Date(span.endTime) }),
          ...(attrs['model'] !== undefined && { model: attrs['model'] as string }),
          input: attrs['input'] as unknown,
          output: attrs['output'] as unknown,
          metadata: {
            ...attrs,
            events: span.events,
            status: span.status,
          },
          usage: {
            ...(attrs['inputTokens'] !== undefined && { input: attrs['inputTokens'] as number }),
            ...(attrs['outputTokens'] !== undefined && { output: attrs['outputTokens'] as number }),
          },
        });
      } else {
        lfTrace.span({
          name: span.name,
          startTime: new Date(span.startTime),
          ...(span.endTime !== undefined && { endTime: new Date(span.endTime) }),
          metadata: {
            ...attrs,
            events: span.events,
            status: span.status,
            ...(span.parentId !== undefined && { parentId: span.parentId }),
          },
        });
      }
    },

    async flush(): Promise<void> {
      await client.flushAsync();
      traceMap.clear();
    },

    async shutdown(): Promise<void> {
      await client.flushAsync();
      traceMap.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// PromptBackend
// ---------------------------------------------------------------------------

/** Configuration for the Langfuse prompt backend. */
export interface LangfusePromptBackendConfig {
  /** A pre-configured Langfuse client instance. */
  readonly client: Langfuse;
}

/**
 * Create a PromptBackend that fetches prompt templates from Langfuse
 * prompt management.
 *
 * Langfuse prompts use `{{variable}}` placeholders which map directly
 * to harness-one template variables.
 */
export function createLangfusePromptBackend(config: LangfusePromptBackendConfig): PromptBackend {
  const { client } = config;
  const knownPromptNames = new Set<string>();

  function toPromptTemplate(
    name: string,
    lfPrompt: { prompt: unknown; version: number },
  ): PromptTemplate {
    const content = String(lfPrompt.prompt);
    const variableMatches = content.match(/\{\{(\w+)\}\}/g) ?? [];
    const variables = [...new Set(variableMatches.map((m) => m.replace(/\{\{|\}\}/g, '')))];

    return {
      id: name,
      version: String(lfPrompt.version),
      content,
      variables,
      metadata: {
        source: 'langfuse',
        fetchedAt: Date.now(),
      },
    };
  }

  return {
    async fetch(id: string, _version?: string): Promise<PromptTemplate | undefined> {
      try {
        const lfPrompt = await client.getPrompt(id);
        knownPromptNames.add(id);
        return toPromptTemplate(id, lfPrompt as { prompt: unknown; version: number });
      } catch (err) {
        // Log warning instead of silently swallowing — network/auth failures should be visible
        if (typeof console !== 'undefined') {
          console.warn(`[harness-one/langfuse] Failed to fetch prompt "${id}":`, err instanceof Error ? err.message : err);
        }
        return undefined;
      }
    },

    async list(): Promise<PromptTemplate[]> {
      const templates: PromptTemplate[] = [];
      for (const name of knownPromptNames) {
        try {
          const lfPrompt = await client.getPrompt(name);
          templates.push(toPromptTemplate(name, lfPrompt as { prompt: unknown; version: number }));
        } catch (err) {
          if (typeof console !== 'undefined') {
            console.warn(`[harness-one/langfuse] Failed to fetch prompt "${name}" during list:`, err instanceof Error ? err.message : err);
          }
          knownPromptNames.delete(name);
        }
      }
      return templates;
    },

    async push(_template: PromptTemplate): Promise<void> {
      throw new HarnessError(
        'Langfuse SDK does not support pushing prompts programmatically',
        'UNSUPPORTED_OPERATION',
        'Use the Langfuse UI or REST API to create prompts',
      );
    },
  };
}

// ---------------------------------------------------------------------------
// CostTracker (Langfuse-backed)
// ---------------------------------------------------------------------------

/** Configuration for the Langfuse cost tracker. */
export interface LangfuseCostTrackerConfig {
  /** A pre-configured Langfuse client instance. */
  readonly client: Langfuse;
  /** Warning threshold (0-1). Defaults to 0.8. */
  readonly warningThreshold?: number;
  /** Critical threshold (0-1). Defaults to 0.95. */
  readonly criticalThreshold?: number;
}

/**
 * Create a CostTracker that records costs via Langfuse generations.
 *
 * Each usage record is exported as a Langfuse generation with cost metadata,
 * while also tracking totals locally for budget alerts.
 */
export function createLangfuseCostTracker(config: LangfuseCostTrackerConfig): CostTracker {
  const { client } = config;
  const pricing = new Map<string, ModelPricing>();
  const records: TokenUsageRecord[] = [];
  const alertHandlers: ((alert: CostAlert) => void)[] = [];
  let budget: number | undefined;
  let runningTotal = 0;
  const warningThreshold = config.warningThreshold ?? 0.8;
  const criticalThreshold = config.criticalThreshold ?? 0.95;

  function computeCost(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): number {
    const p = pricing.get(usage.model);
    if (!p) return 0;
    let cost = 0;
    cost += (usage.inputTokens / 1000) * p.inputPer1kTokens;
    cost += (usage.outputTokens / 1000) * p.outputPer1kTokens;
    if (usage.cacheReadTokens && p.cacheReadPer1kTokens) {
      cost += (usage.cacheReadTokens / 1000) * p.cacheReadPer1kTokens;
    }
    if (usage.cacheWriteTokens && p.cacheWritePer1kTokens) {
      cost += (usage.cacheWriteTokens / 1000) * p.cacheWritePer1kTokens;
    }
    return cost;
  }

  function emitAlert(alert: CostAlert): void {
    for (const handler of alertHandlers) {
      handler(alert);
    }
  }

  const tracker: CostTracker = {
    setPricing(newPricing: ModelPricing[]): void {
      for (const p of newPricing) {
        pricing.set(p.model, p);
      }
    },

    recordUsage(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): TokenUsageRecord {
      const estimatedCost = computeCost(usage);
      const record: TokenUsageRecord = {
        ...usage,
        estimatedCost,
        timestamp: Date.now(),
      };
      records.push(record);
      runningTotal += estimatedCost;

      // Export to Langfuse as a generation with cost metadata
      const trace = client.trace({ id: usage.traceId, name: 'cost-tracking' });
      trace.generation({
        name: `usage-${usage.model}`,
        model: usage.model,
        usage: {
          input: usage.inputTokens,
          output: usage.outputTokens,
        },
        metadata: {
          estimatedCost,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
      });

      if (budget !== undefined) {
        const alert = tracker.checkBudget();
        if (alert) {
          emitAlert(alert);
        }
      }

      return record;
    },

    getTotalCost(): number {
      return runningTotal;
    },

    getCostByModel(): Record<string, number> {
      const result: Record<string, number> = {};
      for (const r of records) {
        result[r.model] = (result[r.model] ?? 0) + r.estimatedCost;
      }
      return result;
    },

    getCostByTrace(traceId: string): number {
      return records
        .filter((r) => r.traceId === traceId)
        .reduce((sum, r) => sum + r.estimatedCost, 0);
    },

    setBudget(newBudget: number): void {
      budget = newBudget;
    },

    checkBudget(): CostAlert | null {
      if (budget === undefined) return null;
      const currentCost = tracker.getTotalCost();
      const percentUsed = currentCost / budget;

      if (percentUsed >= criticalThreshold) {
        return {
          type: 'critical',
          currentCost,
          budget,
          percentUsed,
          message: `Critical: ${(percentUsed * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(4)} / $${budget.toFixed(2)})`,
        };
      }
      if (percentUsed >= warningThreshold) {
        return {
          type: 'warning',
          currentCost,
          budget,
          percentUsed,
          message: `Warning: ${(percentUsed * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(4)} / $${budget.toFixed(2)})`,
        };
      }
      return null;
    },

    onAlert(handler: (alert: CostAlert) => void): void {
      alertHandlers.push(handler);
    },

    reset(): void {
      records.length = 0;
      runningTotal = 0;
    },

    getAlertMessage(): string | null {
      if (budget === undefined) return null;
      const currentCost = tracker.getTotalCost();
      const percentUsed = currentCost / budget;

      if (percentUsed >= criticalThreshold) {
        return `[BUDGET CRITICAL] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Be extremely concise.`;
      }
      if (percentUsed >= warningThreshold) {
        return `[BUDGET WARNING] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Please be concise.`;
      }
      return null;
    },
  };

  return tracker;
}
