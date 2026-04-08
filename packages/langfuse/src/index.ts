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

// ---------------------------------------------------------------------------
// TraceExporter
// ---------------------------------------------------------------------------

/** Configuration for the Langfuse trace exporter. */
export interface LangfuseExporterConfig {
  /** A pre-configured Langfuse client instance. */
  readonly client: Langfuse;
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
      }

      const isGeneration =
        span.attributes['model'] !== undefined ||
        span.name.includes('llm') ||
        span.name.includes('chat');

      if (isGeneration) {
        lfTrace.generation({
          name: span.name,
          startTime: new Date(span.startTime),
          endTime: span.endTime ? new Date(span.endTime) : undefined,
          model: span.attributes['model'] as string | undefined,
          input: span.attributes['input'] as unknown,
          output: span.attributes['output'] as unknown,
          metadata: {
            ...span.attributes,
            events: span.events,
            status: span.status,
          },
          usage: {
            input: span.attributes['inputTokens'] as number | undefined,
            output: span.attributes['outputTokens'] as number | undefined,
          },
        });
      } else {
        lfTrace.span({
          name: span.name,
          startTime: new Date(span.startTime),
          endTime: span.endTime ? new Date(span.endTime) : undefined,
          metadata: {
            ...span.attributes,
            events: span.events,
            status: span.status,
            parentId: span.parentId,
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
        return toPromptTemplate(id, lfPrompt as { prompt: unknown; version: number });
      } catch {
        return undefined;
      }
    },

    async list(): Promise<PromptTemplate[]> {
      // Langfuse SDK does not have a native "list all prompts" method.
      // In production, maintain a known list of prompt names and fetch each.
      return [];
    },

    async push(template: PromptTemplate): Promise<void> {
      // Langfuse prompt creation is typically done via the UI or REST API.
      // This is a placeholder showing the pattern.
      void template;
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
  const warningThreshold = 0.8;
  const criticalThreshold = 0.95;

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
      return records.reduce((sum, r) => sum + r.estimatedCost, 0);
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
