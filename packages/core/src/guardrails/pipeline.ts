/**
 * Guardrail pipeline — runs guardrails in sequence with short-circuit logic.
 *
 * @module
 */

import type { Guardrail, GuardrailContext, GuardrailEvent, PipelineResult } from './types.js';
import { HarnessError } from '../core/errors.js';

/** Unique symbol used as a brand key for pipeline internal data. */
const PIPELINE_BRAND = Symbol('GuardrailPipeline');

/** Branded pipeline type to prevent direct construction. */
export interface GuardrailPipeline {
  readonly _brand: unique symbol;
}

interface PipelineEntry {
  name: string;
  guard: Guardrail;
  timeoutMs?: number;
}

interface PipelineInternalData {
  input: PipelineEntry[];
  output: PipelineEntry[];
  failClosed: boolean;
  onEvent: ((event: GuardrailEvent) => void) | undefined;
  maxResults: number;
}

/** A branded pipeline object that carries internal data via a symbol key. */
interface BrandedPipeline {
  [PIPELINE_BRAND]: PipelineInternalData;
}

function getInternal(pipeline: GuardrailPipeline): PipelineInternalData {
  const branded = pipeline as unknown as Partial<BrandedPipeline>;
  const data = branded[PIPELINE_BRAND];
  if (!data) {
    throw new HarnessError('Invalid GuardrailPipeline instance', 'INVALID_PIPELINE', 'Use createPipeline() to create pipelines');
  }
  return data;
}

/**
 * Create a guardrail pipeline.
 *
 * **Fail-closed vs fail-open behavior:**
 * - When `failClosed` is `true` (default) and a guardrail throws an exception,
 *   the content is **BLOCKED** (safe default). This is the recommended setting
 *   for production environments where safety is paramount.
 * - When `failClosed` is `false` and a guardrail throws an exception, the
 *   exception is caught, an event is emitted, and the content is **ALLOWED**
 *   (fail-open). Use this only when availability is more important than safety.
 *
 * **Default timeout:**
 * If a guard entry does not specify `timeoutMs`, the pipeline applies `defaultTimeoutMs`
 * (default: 5000ms). This prevents synchronous or hanging guards from blocking the event
 * loop indefinitely. Set `defaultTimeoutMs` to `0` to disable the default timeout.
 *
 * @example
 * ```ts
 * const pipeline = createPipeline({
 *   input: [{ name: 'filter', guard: myGuard }],
 *   failClosed: true,
 * });
 * ```
 */
export function createPipeline(config: {
  input?: Array<{ name: string; guard: Guardrail; timeoutMs?: number }>;
  output?: Array<{ name: string; guard: Guardrail; timeoutMs?: number }>;
  failClosed?: boolean;
  onEvent?: (event: GuardrailEvent) => void;
  /** Default timeout (ms) for guards that don't specify their own timeoutMs. Default: 5000. Set to 0 to disable. */
  defaultTimeoutMs?: number;
  /** Maximum number of guardrail events to retain in results. Oldest non-error events are evicted when exceeded. Default: 1000. */
  maxResults?: number;
}): GuardrailPipeline {
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 5000;

  // Apply default timeout to guards that don't specify their own
  const applyDefaults = (entries: PipelineEntry[]): PipelineEntry[] =>
    entries.map((entry) => {
      const resolved = entry.timeoutMs ?? (defaultTimeoutMs > 0 ? defaultTimeoutMs : undefined);
      const result: PipelineEntry = { name: entry.name, guard: entry.guard };
      if (resolved !== undefined) {
        result.timeoutMs = resolved;
      }
      return result;
    });

  const internalData: PipelineInternalData = {
    input: applyDefaults(config.input ?? []),
    output: applyDefaults(config.output ?? []),
    failClosed: config.failClosed ?? true,
    onEvent: config.onEvent,
    maxResults: config.maxResults ?? 1000,
  };
  const branded: BrandedPipeline = { [PIPELINE_BRAND]: internalData };
  return branded as unknown as GuardrailPipeline;
}

/**
 * Push an event into results, evicting the oldest non-error event if the cap is reached.
 * Error events (block from errors) are never evicted to preserve audit trail.
 */
function pushEvent(results: GuardrailEvent[], event: GuardrailEvent, maxResults: number): void {
  if (results.length >= maxResults) {
    // Evict the oldest non-block event to keep the array bounded
    const evictIdx = results.findIndex((e) => e.verdict.action !== 'block');
    if (evictIdx !== -1) {
      results.splice(evictIdx, 1);
    } else {
      // All events are block events — evict the oldest one
      results.shift();
    }
  }
  results.push(event);
}

async function runGuardrails(
  pipeline: PipelineInternalData,
  guards: PipelineEntry[],
  direction: 'input' | 'output',
  ctx: GuardrailContext,
): Promise<PipelineResult> {
  const results: GuardrailEvent[] = [];
  let currentCtx: GuardrailContext = ctx.meta ? { ...ctx, meta: { ...ctx.meta } } : { ...ctx };
  let lastModifyVerdict: GuardrailEvent['verdict'] | undefined;
  let hasModified = false;

  for (const entry of guards) {
    const start = performance.now();
    let verdict: GuardrailEvent['verdict'];
    // Deep clone meta for each guard to prevent cross-guard mutation
    const guardCtx: GuardrailContext = currentCtx.meta
      ? { ...currentCtx, meta: { ...currentCtx.meta } }
      : { ...currentCtx };

    try {
      if (entry.timeoutMs !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          verdict = await Promise.race([
            Promise.resolve(entry.guard(guardCtx)),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Guardrail "${entry.name}" timed out after ${entry.timeoutMs}ms`)),
                entry.timeoutMs,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } else {
        verdict = await entry.guard(guardCtx);
      }
    } catch (err) {
      if (pipeline.failClosed) {
        const message = err instanceof Error ? err.message : String(err);
        verdict = { action: 'block', reason: `Guardrail error: ${message}` };
        const event: GuardrailEvent = {
          guardrail: entry.name,
          direction,
          verdict,
          latencyMs: performance.now() - start,
        };
        pushEvent(results, event, pipeline.maxResults);
        pipeline.onEvent?.(event);
        return { passed: false, verdict, results };
      }
      // failOpen: emit event with error info, then skip this guardrail
      const errorVerdict: GuardrailEvent['verdict'] = { action: 'allow' };
      const errorEvent: GuardrailEvent = {
        guardrail: entry.name,
        direction,
        verdict: errorVerdict,
        latencyMs: performance.now() - start,
      };
      pushEvent(results, errorEvent, pipeline.maxResults);
      pipeline.onEvent?.(errorEvent);
      continue;
    }

    const event: GuardrailEvent = {
      guardrail: entry.name,
      direction,
      verdict,
      latencyMs: performance.now() - start,
    };
    pushEvent(results, event, pipeline.maxResults);
    pipeline.onEvent?.(event);

    if (verdict.action === 'block') {
      return { passed: false, verdict, results };
    }

    if (verdict.action === 'modify') {
      hasModified = true;
      lastModifyVerdict = verdict;
      if (verdict.modified !== undefined) {
        currentCtx = currentCtx.meta
          ? { ...currentCtx, content: verdict.modified, meta: { ...currentCtx.meta } }
          : { ...currentCtx, content: verdict.modified };
      }
      // Continue to next guardrail instead of short-circuiting
    }
  }

  if (hasModified && lastModifyVerdict) {
    return {
      passed: true,
      verdict: lastModifyVerdict,
      results,
      modifiedContent: currentCtx.content,
    };
  }

  const allowVerdict: GuardrailEvent['verdict'] = { action: 'allow' };
  return { passed: true, verdict: allowVerdict, results };
}

/** Run input guardrails in sequence. */
export async function runInput(
  pipeline: GuardrailPipeline,
  ctx: GuardrailContext,
): Promise<PipelineResult> {
  const p = getInternal(pipeline);
  return runGuardrails(p, p.input, 'input', ctx);
}

/** Run output guardrails in sequence. */
export async function runOutput(
  pipeline: GuardrailPipeline,
  ctx: GuardrailContext,
): Promise<PipelineResult> {
  const p = getInternal(pipeline);
  return runGuardrails(p, p.output, 'output', ctx);
}

/** Run output guardrails on tool execution results. */
export async function runToolOutput(
  pipeline: GuardrailPipeline,
  toolResult: string,
  toolName?: string,
): Promise<PipelineResult> {
  const p = getInternal(pipeline);
  const ctx: GuardrailContext = {
    content: toolResult,
    ...(toolName !== undefined && { meta: { toolName } }),
  };
  return runGuardrails(p, p.output, 'output', ctx);
}
