/**
 * CLI argument parsing logic.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from 'harness-one';

// ── Module definitions ────────────────────────────────────────────────────────

// `Object.freeze` + `as const` makes these module-scoped registries immutable
// at both compile time (readonly tuple / Readonly record) and runtime (frozen
// object). Without runtime freeze, a downstream consumer could mutate the
// array / object and silently corrupt every other caller in the same process.
// The cast keeps the tuple literal type intact after `Object.freeze`, which
// returns `Readonly<T>` and loses tuple narrowing without this annotation.
export const ALL_MODULES = Object.freeze([
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
] as const);

export type ModuleName = (typeof ALL_MODULES)[number];

// Frozen so a rogue import cannot `delete MODULE_DESCRIPTIONS.core` or
// overwrite a description at runtime. The `as const` preserves literal string
// types; `Object.freeze` enforces runtime immutability. Together they match
// the contract surfaced via `Record<ModuleName, string>` — callers treat it
// as read-only, and the runtime agrees.
export const MODULE_DESCRIPTIONS: Readonly<Record<ModuleName, string>> = Object.freeze({
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
} as const);

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
    // Surface via HarnessError so wrappers / test harnesses can catch by
    // `.code === HarnessErrorCode.CLI_PARSE_ERROR` instead of string-matching.
    throw new HarnessError(
      'Conflicting flags: --all and --modules cannot be used together.',
      HarnessErrorCode.CLI_PARSE_ERROR,
      'Use --all to select all modules, or --modules to select specific ones.',
    );
  }

  if (all) {
    modules = [...ALL_MODULES];
  }

  return { command: command as 'init' | 'audit', all, modules };
}
