/**
 * Guardrail pipeline — runs guardrails in sequence with short-circuit logic.
 *
 * @module
 */

import type { Guardrail, GuardrailContext, GuardrailEvent, PipelineResult } from './types.js';
import { HarnessError } from '../core/errors.js';

/**
 * Branded pipeline type — an opaque token returned by {@link createPipeline}.
 * The internal state lives in a module-scoped WeakMap keyed by the token,
 * so consumers cannot reach in and mutate it, and no `as unknown as` dance
 * is needed to recover it.
 */
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

/**
 * CQ-031: private registry mapping pipeline tokens → internal state. A
 * `WeakMap` lets us hand out opaque tokens (`GuardrailPipeline`) while keeping
 * their state out of the object itself — callers cannot observe or mutate it,
 * and no double-cast is needed to recover it from inside this module.
 *
 * The WeakMap holds only weak references to tokens, so once a consumer drops
 * their pipeline handle the internal state is eligible for garbage collection.
 */
const internalRegistry: WeakMap<GuardrailPipeline, PipelineInternalData> = new WeakMap();

function getInternal(pipeline: GuardrailPipeline): PipelineInternalData {
  const data = internalRegistry.get(pipeline);
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
  // CQ-031: the public `GuardrailPipeline` token is a plain opaque object.
  // Its internal state lives in the module-scoped `internalRegistry` WeakMap
  // so consumers cannot reach in and mutate it. `Object.freeze` prevents
  // tampering via property writes on the token itself.
  const pipeline = Object.freeze({}) as GuardrailPipeline;
  internalRegistry.set(pipeline, internalData);
  return pipeline;
}

/**
 * PERF-005: bounded event buffer with O(1) amortized eviction of the oldest
 * non-block event. Block events are never evicted (they are part of the audit
 * trail of reasons a pipeline rejected content).
 *
 * The previous implementation used `Array.findIndex` on every eviction, which
 * was O(n) in `maxResults`. For high-throughput pipelines with maxResults in
 * the thousands this dominated push latency. We now maintain an explicit
 * pointer to the oldest non-block index; it only advances forward, and is
 * re-scanned lazily the first time the pointer falls behind the head of the
 * array (rare: happens only after shift() on an all-block prefix).
 */
class BoundedEventBuffer {
  readonly results: GuardrailEvent[] = [];
  /** Index of the oldest event with verdict.action !== 'block'; -1 if none. */
  private oldestNonBlockIdx: number = -1;

  constructor(private readonly maxResults: number) {}

  push(event: GuardrailEvent): void {
    if (this.results.length >= this.maxResults) {
      if (this.oldestNonBlockIdx >= 0 && this.oldestNonBlockIdx < this.results.length) {
        // Evict at the tracked pointer (O(n) splice into the middle is
        // unavoidable for a plain array, but finding the target is O(1)).
        this.results.splice(this.oldestNonBlockIdx, 1);
        // The pointer now references the NEXT element — recompute from that
        // position forward (usually 0 or 1 step).
        this.oldestNonBlockIdx = this.findNextNonBlock(this.oldestNonBlockIdx);
      } else {
        // All events in the buffer are block events — evict the oldest one.
        this.results.shift();
        // Any existing pointer shifts left by 1.
        if (this.oldestNonBlockIdx > 0) this.oldestNonBlockIdx--;
      }
    }
    const newIdx = this.results.push(event) - 1;
    if (
      event.verdict.action !== 'block' &&
      (this.oldestNonBlockIdx === -1 || this.oldestNonBlockIdx >= this.results.length)
    ) {
      this.oldestNonBlockIdx = newIdx;
    }
  }

  private findNextNonBlock(fromIdx: number): number {
    for (let i = fromIdx; i < this.results.length; i++) {
      if (this.results[i].verdict.action !== 'block') return i;
    }
    return -1;
  }
}

async function runGuardrails(
  pipeline: PipelineInternalData,
  guards: PipelineEntry[],
  direction: 'input' | 'output',
  ctx: GuardrailContext,
): Promise<PipelineResult> {
  const buffer = new BoundedEventBuffer(pipeline.maxResults);
  const results = buffer.results;
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
        buffer.push(event);
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
      buffer.push(errorEvent);
      pipeline.onEvent?.(errorEvent);
      continue;
    }

    const event: GuardrailEvent = {
      guardrail: entry.name,
      direction,
      verdict,
      latencyMs: performance.now() - start,
    };
    buffer.push(event);
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
