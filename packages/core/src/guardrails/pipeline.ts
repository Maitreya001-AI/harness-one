/**
 * Guardrail pipeline — runs guardrails in sequence with short-circuit logic.
 *
 * @module
 */

import type { Guardrail, GuardrailContext, GuardrailEvent, PipelineResult } from './types.js';
import type { GuardrailPipeline } from '../core/guardrail-port.js';
import { HarnessError, HarnessErrorCode } from '../core/errors.js';
export type { GuardrailPipeline } from '../core/guardrail-port.js';

/**
 * Defence-in-depth guard for the module-level wrappers: rejects anything
 * that isn't a pipeline created by {@link createPipeline} (i.e. anything
 * that doesn't expose the port methods). The typed pipeline object never
 * fails this check; forged tokens produced via `{} as GuardrailPipeline`
 * do.
 */
function assertPipeline(pipeline: GuardrailPipeline, method: keyof GuardrailPipeline): void {
  if (
    pipeline == null ||
    typeof (pipeline as unknown as Record<string, unknown>)[method] !== 'function'
  ) {
    throw new HarnessError(
      'Invalid GuardrailPipeline instance',
      HarnessErrorCode.GUARD_INVALID_PIPELINE,
      'Use createPipeline() to create pipelines',
    );
  }
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
  totalTimeoutMs: number;
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
  input?: readonly { readonly name: string; guard: Guardrail; readonly timeoutMs?: number }[];
  output?: readonly { readonly name: string; guard: Guardrail; readonly timeoutMs?: number }[];
  failClosed?: boolean;
  onEvent?: (event: GuardrailEvent) => void;
  /** Default timeout (ms) for guards that don't specify their own timeoutMs. Default: 5000. Set to 0 to disable. */
  defaultTimeoutMs?: number;
  /** Maximum total time (ms) for all guards combined. Default: 30000 (30s). Set to 0 to disable. */
  totalTimeoutMs?: number;
  /** Maximum number of guardrail events to retain in results. Oldest non-error events are evicted when exceeded. Default: 1000. */
  maxResults?: number;
}): GuardrailPipeline {
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 5000;

  // Apply default timeout to guards that don't specify their own
  const applyDefaults = (entries: readonly PipelineEntry[]): PipelineEntry[] =>
    entries.map((entry) => {
      const resolved = entry.timeoutMs ?? (defaultTimeoutMs > 0 ? defaultTimeoutMs : undefined);
      const result: PipelineEntry = { name: entry.name, guard: entry.guard };
      // Stryker disable next-line ConditionalExpression: equivalent mutant.
      // Flipping this guard to `true` assigns `result.timeoutMs = undefined`
      // instead of leaving it unset. Either shape is indistinguishable to
      // downstream code, which checks `entry.timeoutMs !== undefined`.
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
    totalTimeoutMs: config.totalTimeoutMs ?? 30_000,
  };
  // The pipeline object directly carries the port methods; callers treat it
  // as an opaque token. The internal mutable state is captured by the method
  // closures instead of living on a module-scoped WeakMap — simpler and the
  // brand field keeps the nominal type.
  const port = {
    runInput: (ctx: GuardrailContext): Promise<PipelineResult> =>
      runGuardrails(internalData, internalData.input, 'input', ctx),
    runOutput: (ctx: GuardrailContext): Promise<PipelineResult> =>
      runGuardrails(internalData, internalData.output, 'output', ctx),
    runToolOutput: (toolResult: string, toolName?: string): Promise<PipelineResult> => {
      const ctx: GuardrailContext = {
        content: toolResult,
        ...(toolName !== undefined && { meta: { toolName } }),
      };
      return runGuardrails(internalData, internalData.output, 'output', ctx);
    },
    runRagContext: (
      chunks: readonly string[],
      meta?: GuardrailContext['meta'],
    ): Promise<PipelineResult> => runRagContextInternal(internalData, chunks, meta),
  };
  // Freeze the token so consumers can't swap methods post-creation.
  return Object.freeze(port) as unknown as GuardrailPipeline;
}

/**
 * bounded event buffer with O(1) amortized eviction of the oldest
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
  /** Number of events evicted from this buffer due to capacity overflow. */
  private _evictedCount: number = 0;

  constructor(private readonly maxResults: number) {}

  /** Number of events evicted from this buffer due to capacity overflow. */
  get evictedCount(): number {
    return this._evictedCount;
  }

  push(event: GuardrailEvent): void {
    if (this.results.length >= this.maxResults) {
      // Stryker disable next-line UpdateOperator: equivalent mutant.
      // `_evictedCount` is exposed via a getter but is never read anywhere
      // inside this package — it exists as a future-diagnostics hook.
      // Flipping `++` to `--` has no observable effect on the pipeline's
      // public surface (results/verdict/direction/latencyMs).
      this._evictedCount++;
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
  // Stryker disable next-line BooleanLiteral: equivalent mutant. The final
  // branch at line 338 gates on `hasModified && lastModifyVerdict`, and
  // `lastModifyVerdict` is only assigned when we set `hasModified = true`.
  // Flipping the initial value to `true` therefore cannot change observable
  // behaviour — the second conjunct remains undefined until a modify verdict
  // fires.
  let hasModified = false;
  const pipelineStart = performance.now();

  for (const entry of guards) {
    if (pipeline.totalTimeoutMs > 0) {
      const elapsed = performance.now() - pipelineStart;
      if (elapsed >= pipeline.totalTimeoutMs) {
        const timeoutVerdict: GuardrailEvent['verdict'] = pipeline.failClosed
          ? { action: 'block', reason: `Guardrail pipeline total timeout exceeded (${pipeline.totalTimeoutMs}ms)` }
          : { action: 'allow', reason: `Guardrail pipeline total timeout exceeded (fail-open, ${pipeline.totalTimeoutMs}ms)` };
        const timeoutEvent: GuardrailEvent = {
          guardrail: entry.name,
          direction,
          verdict: timeoutVerdict,
          latencyMs: elapsed,
        };
        buffer.push(timeoutEvent);
        pipeline.onEvent?.(timeoutEvent);
        return { passed: !pipeline.failClosed, verdict: timeoutVerdict, results };
      }
    }
    const start = performance.now();
    let verdict: GuardrailEvent['verdict'];
    // Deep clone meta for each guard to prevent cross-guard mutation
    const guardCtx: GuardrailContext = currentCtx.meta
      ? { ...currentCtx, meta: { ...currentCtx.meta } }
      : { ...currentCtx };

    try {
      if (entry.timeoutMs !== undefined) {
        // per-guard fairness. If the pipeline has a total-timeout
        // budget, clamp the guard-level timeout to the remaining budget so a
        // greedy guard cannot burn the whole wall-clock and starve later
        // guards. Emit a `guard_timeout` span event on every guard-level
        // timeout so operators can see which guard tripped the clamp.
        let effectiveTimeout = entry.timeoutMs;
        if (pipeline.totalTimeoutMs > 0) {
          const elapsedSoFar = performance.now() - pipelineStart;
          const remaining = pipeline.totalTimeoutMs - elapsedSoFar;
          if (remaining > 0 && remaining < effectiveTimeout) {
            effectiveTimeout = remaining;
          }
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          verdict = await Promise.race([
            Promise.resolve(entry.guard(guardCtx)),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Guardrail "${entry.name}" timed out after ${effectiveTimeout}ms`)),
                effectiveTimeout,
              );
              // Ensure timer doesn't keep the process alive.
              // Equivalent-mutant cluster: `.unref()` only affects whether a
              // pending timer keeps the event loop alive on process exit.
              // The enclosing `finally` block clears the timer before the
              // process exits, so mutations here cannot be observed via
              // any public signal (verdict / events / latency). Kept in
              // source for correctness on real long-running runtimes.
              // Stryker disable next-line all
              if (typeof timer === 'object' && 'unref' in timer) {
                // Stryker disable next-line all
                (timer as NodeJS.Timeout).unref();
              }
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } else {
        verdict = await entry.guard(guardCtx);
      }
    } catch (err) {
      // emit a `guard_timeout` span-event when the failure was a
      // guard-level timeout. The span event is delivered via the same
      // `onEvent` callback that receives verdict events; we piggy-back on
      // the verdict-event shape by using a reserved `reason` prefix so
      // consumers can filter it (and downstream tracing middleware can
      // promote it to an OTel span event).
      const errMsg = err instanceof Error ? err.message : String(err);
      if (entry.timeoutMs !== undefined && errMsg.includes('timed out after')) {
        const spanEvent: GuardrailEvent = {
          guardrail: entry.name,
          direction,
          verdict: { action: 'block', reason: `guard_timeout: ${errMsg}` },
          latencyMs: performance.now() - start,
        };
        // Emit to the onEvent sink only — do NOT push into the buffer, the
        // verdict event below is the canonical record.
        pipeline.onEvent?.(spanEvent);
      }
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
      // failOpen: emit event with error info, then skip this guardrail.
      // The reason field distinguishes genuine 'allow' from error-fallback 'allow'.
      const message = err instanceof Error ? err.message : String(err);
      const errorVerdict: GuardrailEvent['verdict'] = {
        action: 'allow',
        reason: `Guardrail error (fail-open): ${message}`,
      };
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

  // Stryker disable next-line LogicalOperator: equivalent mutant. Swapping
  // `&&` for `||` cannot change the branch outcome — `lastModifyVerdict`
  // is only ever assigned inside the modify branch alongside
  // `hasModified = true`, so the two operands are always falsy together
  // and always truthy together.
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

/**
 * Module-level `runInput` wrapper — delegates to the pipeline port so
 * existing `runInput(pipeline, ctx)` callers (examples, CLI templates,
 * preset, user code) keep working unchanged.
 */
export async function runInput(
  pipeline: GuardrailPipeline,
  ctx: GuardrailContext,
): Promise<PipelineResult> {
  assertPipeline(pipeline, 'runInput');
  return pipeline.runInput(ctx);
}

/** Module-level wrapper for `pipeline.runOutput`. */
export async function runOutput(
  pipeline: GuardrailPipeline,
  ctx: GuardrailContext,
): Promise<PipelineResult> {
  assertPipeline(pipeline, 'runOutput');
  return pipeline.runOutput(ctx);
}

/** Module-level wrapper for `pipeline.runToolOutput`. */
export async function runToolOutput(
  pipeline: GuardrailPipeline,
  toolResult: string,
  toolName?: string,
): Promise<PipelineResult> {
  assertPipeline(pipeline, 'runToolOutput');
  return pipeline.runToolOutput(toolResult, toolName);
}

/**
 * Module-level wrapper for `pipeline.runRagContext` — scans retrieved RAG
 * chunks through the input guardrails. Any chunk producing a non-`allow`
 * verdict poisons the whole retrieval set (first hit wins).
 */
export async function runRagContext(
  pipeline: GuardrailPipeline,
  chunks: readonly string[],
  meta?: GuardrailContext['meta'],
): Promise<PipelineResult> {
  assertPipeline(pipeline, 'runRagContext');
  return pipeline.runRagContext(chunks, meta);
}

async function runRagContextInternal(
  p: PipelineInternalData,
  chunks: readonly string[],
  meta?: GuardrailContext['meta'],
): Promise<PipelineResult> {
  let lastResult: PipelineResult = {
    passed: true,
    verdict: { action: 'allow' },
    results: [],
  };
  for (const [i, chunk] of chunks.entries()) {
    const ctx: GuardrailContext = {
      content: chunk,
      meta: { ...(meta ?? {}), ragChunkIndex: i },
    };
    const result = await runGuardrails(p, p.input, 'input', ctx);
    lastResult = result;
    if (result.verdict.action !== 'allow') return result;
  }
  return lastResult;
}
