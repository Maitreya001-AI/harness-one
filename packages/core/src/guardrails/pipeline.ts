/**
 * Guardrail pipeline — runs guardrails in sequence with short-circuit logic.
 *
 * @module
 */

import type { Guardrail, GuardrailContext, GuardrailEvent, PipelineResult } from './types.js';
import { HarnessError } from '../core/errors.js';

/** Branded pipeline type to prevent direct construction. */
export interface GuardrailPipeline {
  readonly _brand: unique symbol;
}

interface PipelineEntry {
  name: string;
  guard: Guardrail;
  timeoutMs?: number;
}

interface PipelineInternal extends GuardrailPipeline {
  input: PipelineEntry[];
  output: PipelineEntry[];
  failClosed: boolean;
  onEvent?: (event: GuardrailEvent) => void;
}

const pipelineInstances = new WeakSet<object>();

function getInternal(pipeline: GuardrailPipeline): PipelineInternal {
  if (!pipelineInstances.has(pipeline as unknown as object)) {
    throw new HarnessError('Invalid GuardrailPipeline instance', 'INVALID_PIPELINE', 'Use createPipeline() to create pipelines');
  }
  return pipeline as unknown as PipelineInternal;
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
  const internal = {
    input: config.input ?? [],
    output: config.output ?? [],
    failClosed: config.failClosed ?? true,
    onEvent: config.onEvent,
  };
  pipelineInstances.add(internal);
  return internal as unknown as GuardrailPipeline;
}

async function runGuardrails(
  pipeline: PipelineInternal,
  guards: PipelineEntry[],
  direction: 'input' | 'output',
  ctx: GuardrailContext,
): Promise<PipelineResult> {
  const results: GuardrailEvent[] = [];

  for (const entry of guards) {
    const start = performance.now();
    let verdict: GuardrailEvent['verdict'];

    try {
      if (entry.timeoutMs !== undefined) {
        verdict = await Promise.race([
          Promise.resolve(entry.guard(ctx)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Guardrail "${entry.name}" timed out after ${entry.timeoutMs}ms`)), entry.timeoutMs),
          ),
        ]);
      } else {
        verdict = await entry.guard(ctx);
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

    if (verdict.action === 'block' || verdict.action === 'modify') {
      return {
        passed: verdict.action !== 'block',
        verdict,
        results,
      };
    }
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
