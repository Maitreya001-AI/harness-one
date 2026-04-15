/**
 * CLI argument parsing logic.
 *
 * @module
 */

import { HarnessError } from 'harness-one';

// ── Module definitions ────────────────────────────────────────────────────────

export const ALL_MODULES = [
  'core',
  'prompt',
  'context',
  'tools',
  'guardrails',
  'observe',
  'session',
  'memory',
  'eval',
  'evolve',
  'orchestration',
  'rag',
] as const;

export type ModuleName = (typeof ALL_MODULES)[number];

export const MODULE_DESCRIPTIONS: Record<ModuleName, string> = {
  core: 'Agent Loop -- LLM adapter, tool dispatch, safety valves',
  prompt: 'Prompt Engineering -- builder, registry, skills, disclosure',
  context: 'Context Engineering -- token budgets, packing, cache stability',
  tools: 'Tool System -- define, validate, registry',
  guardrails: 'Safety & Guardrails -- pipeline, injection detection, rate limiting',
  observe: 'Observability -- traces, spans, cost tracking',
  session: 'Session Management -- TTL, LRU eviction, locking',
  memory: 'Memory & Persistence -- stores, compaction, cross-context relay',
  eval: 'Evaluation -- runners, scorers, generator-evaluator',
  evolve: 'Continuous Evolution -- component registry, drift detection, architecture rules',
  orchestration: 'Agent Orchestration -- multi-agent coordination, delegation, handoff, boundaries',
  rag: 'Retrieval-Augmented Generation -- loaders, chunking, embeddings, retrievers, pipeline',
};

// ── Argument parser ───────────────────────────────────────────────────────────

export interface ParsedArgs {
  command: 'init' | 'audit' | 'help';
  all: boolean;
  modules: ModuleName[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  // Skip node + script path
  const args = argv.slice(2);
  const command = args[0] as string | undefined;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help', all: false, modules: [] };
  }

  if (command !== 'init' && command !== 'audit') {
    return { command: 'help', all: false, modules: [] };
  }

  const all = args.includes('--all');
  let modules: ModuleName[] = [];

  const modulesIdx = args.indexOf('--modules');
  if (modulesIdx !== -1 && args[modulesIdx + 1]) {
    const raw = args[modulesIdx + 1].split(',').map((s) => s.trim());
    modules = raw.filter((m): m is ModuleName =>
      ALL_MODULES.includes(m as ModuleName),
    );
  }

  if (all && modules.length > 0) {
    // CQ-040: Surface via HarnessError so wrappers / test harnesses can
    // catch by `.code === 'CLI_PARSE_ERROR'` instead of string-matching.
    throw new HarnessError(
      'Conflicting flags: --all and --modules cannot be used together.',
      'CLI_PARSE_ERROR',
      'Use --all to select all modules, or --modules to select specific ones.',
    );
  }

  if (all) {
    modules = [...ALL_MODULES];
  }

  return { command: command as 'init' | 'audit', all, modules };
}
