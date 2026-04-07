/**
 * Guardrail pipeline — runs guardrails in sequence with short-circuit logic.
 *
 * @module
 */

import type { Guardrail, GuardrailContext, GuardrailEvent, PipelineResult } from './types.js';

/** Branded pipeline type to prevent direct construction. */
export interface GuardrailPipeline {
  readonly _brand: unique symbol;
}

interface PipelineEntry {
  name: string;
  guard: Guardrail;
}

interface PipelineInternal extends GuardrailPipeline {
  input: PipelineEntry[];
  output: PipelineEntry[];
  failClosed: boolean;
  onEvent?: (event: GuardrailEvent) => void;
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
  input?: Array<{ name: string; guard: Guardrail }>;
  output?: Array<{ name: string; guard: Guardrail }>;
  failClosed?: boolean;
  onEvent?: (event: GuardrailEvent) => void;
}): GuardrailPipeline {
  return {
    input: config.input ?? [],
    output: config.output ?? [],
    failClosed: config.failClosed ?? true,
    onEvent: config.onEvent,
  } as unknown as GuardrailPipeline;
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
      verdict = await entry.guard(ctx);
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
      // failOpen: skip this guardrail
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
  const p = pipeline as unknown as PipelineInternal;
  return runGuardrails(p, p.input, 'input', ctx);
}

/** Run output guardrails in sequence. */
export async function runOutput(
  pipeline: GuardrailPipeline,
  ctx: GuardrailContext,
): Promise<PipelineResult> {
  const p = pipeline as unknown as PipelineInternal;
  return runGuardrails(p, p.output, 'output', ctx);
}
