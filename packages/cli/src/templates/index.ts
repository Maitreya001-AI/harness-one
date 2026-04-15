/**
 * Template barrel — re-exports the per-module template strings so callers
 * can retrieve them by `ModuleName`.
 *
 * Each template emits a scaffold file into the user's project; the subpath
 * literals inside must match exports in the target workspace package's
 * `package.json`, enforced by `templates-subpaths.test.ts`.
 *
 * @module
 */

import type { ModuleName } from '../parser.js';

import { template as coreTemplate } from './core.js';
import { template as promptTemplate } from './prompt.js';
import { template as contextTemplate } from './context.js';
import { template as toolsTemplate } from './tools.js';
import { template as guardrailsTemplate } from './guardrails.js';
import { template as observeTemplate } from './observe.js';
import { template as sessionTemplate } from './session.js';
import { template as memoryTemplate } from './memory.js';
import { template as evalTemplate } from './eval.js';
import { template as orchestrationTemplate } from './orchestration.js';
import { template as ragTemplate } from './rag.js';
import { template as evolveTemplate } from './evolve.js';

export { SUBPATH_MAP } from './subpath-map.js';
export type { SubpathRef } from './subpath-map.js';

export const TEMPLATES: Record<ModuleName, string> = {
  core: coreTemplate,
  prompt: promptTemplate,
  context: contextTemplate,
  tools: toolsTemplate,
  guardrails: guardrailsTemplate,
  observe: observeTemplate,
  session: sessionTemplate,
  memory: memoryTemplate,
  eval: evalTemplate,
  orchestration: orchestrationTemplate,
  rag: ragTemplate,
  evolve: evolveTemplate,
};

export function getTemplate(mod: ModuleName): string {
  return TEMPLATES[mod];
}

// ── File name mapping ─────────────────────────────────────────────────────────

export const FILE_NAMES: Record<ModuleName, string> = {
  core: 'agent.ts',
  prompt: 'prompt.ts',
  context: 'context.ts',
  tools: 'tools.ts',
  guardrails: 'guardrails.ts',
  observe: 'observe.ts',
  session: 'session.ts',
  memory: 'memory.ts',
  eval: 'eval.ts',
  evolve: 'evolve.ts',
  orchestration: 'orchestration.ts',
  rag: 'rag.ts',
};
