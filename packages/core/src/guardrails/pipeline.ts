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
}): GuardrailPipeline {
  const internalData: PipelineInternalData = {
    input: config.input ?? [],
    output: config.output ?? [],
    failClosed: config.failClosed ?? true,
    onEvent: config.onEvent,
  };
  const branded: BrandedPipeline = { [PIPELINE_BRAND]: internalData };
  return branded as unknown as GuardrailPipeline;
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
        verdict = await Promise.race([
          Promise.resolve(entry.guard(guardCtx)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Guardrail "${entry.name}" timed out after ${entry.timeoutMs}ms`)), entry.timeoutMs),
          ),
        ]);
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
        results.push(event);
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
      results.push(errorEvent);
      pipeline.onEvent?.(errorEvent);
      continue;
    }

    const event: GuardrailEvent = {
      guardrail: entry.name,
      direction,
      verdict,
      latencyMs: performance.now() - start,
    };
    results.push(event);
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
