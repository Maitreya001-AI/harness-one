import type { AgentAdapter } from 'harness-one/core';
import { createSecurePreset, type SecureHarness } from '@harness-one/preset';

/**
 * Build the SecureHarness the triage bot uses.
 *
 * The adapter is passed in (rather than constructed inline) so the entry
 * point can swap between the Anthropic SDK adapter and a deterministic mock
 * adapter based on `DOGFOOD_MOCK=1`. The rest of the preset wiring is held
 * constant between the two paths so the code under test is actually the
 * same code that runs in production.
 */
export interface HarnessFactoryOptions {
  readonly adapter: AgentAdapter;
  readonly model?: string;
  readonly maxIterations?: number;
  readonly budgetUsd?: number;
}

export function buildTriageHarness(options: HarnessFactoryOptions): SecureHarness {
  return createSecurePreset({
    type: 'adapter',
    adapter: options.adapter,
    ...(options.model !== undefined && { model: options.model }),
    guardrailLevel: 'standard',
    maxIterations: options.maxIterations ?? 6,
    ...(options.budgetUsd !== undefined && { budget: options.budgetUsd }),
  });
}
