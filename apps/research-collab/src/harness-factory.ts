/**
 * Build the SecureHarness instances backing each agent role.
 *
 * Each agent role has its own harness so cost / iteration counters / sessions
 * stay isolated. They share guardrail level + budget defaults so production
 * runs are diff-safe between releases.
 *
 * The adapter is injected from the entry point so tests / dry-runs use a
 * deterministic mock; live runs use the Anthropic SDK adapter built in
 * `cli/bin.ts`. This mirrors the dogfood pattern.
 */

import type { AgentAdapter } from 'harness-one/core';
import { createSecurePreset, type SecureHarness } from '@harness-one/preset';

import { DEFAULT_BUDGET_USD, DEFAULT_MODEL, MAX_AGENT_ITERATIONS } from './config/defaults.js';
import type { AgentRole } from './types.js';

export interface BuildAgentHarnessOptions {
  readonly role: AgentRole;
  readonly adapter: AgentAdapter;
  readonly model?: string;
  /**
   * Per-agent budget. The pipeline still enforces a top-level cap by summing
   * costs across roles after each step; this per-agent budget is a defence-
   * in-depth limit so a single runaway agent loop can't burn the whole task.
   */
  readonly budgetUsd?: number;
  readonly maxIterations?: number;
}

/**
 * Build the SecureHarness for a single agent role.
 *
 * Researchers and Coordinators register no tools; Specialists register
 * web_search + web_fetch via {@link buildAgentHarness} after construction.
 */
export function buildAgentHarness(options: BuildAgentHarnessOptions): SecureHarness {
  return createSecurePreset({
    type: 'adapter',
    adapter: options.adapter,
    model: options.model ?? DEFAULT_MODEL,
    guardrailLevel: 'standard',
    maxIterations: options.maxIterations ?? MAX_AGENT_ITERATIONS,
    budget: options.budgetUsd ?? DEFAULT_BUDGET_USD,
  });
}
