/**
 * Source-of-truth mapping of which workspace package + subpath each CLI
 * template imports from. The parser test (`templates-subpaths.test.ts`)
 * uses this plus `packages/core/package.json` `exports` to assert every
 * subpath a template references actually exists.
 *
 * @module
 */

import type { ModuleName } from '../parser.js';

/** The shape of a subpath reference in a scaffolded template. */
export interface SubpathRef {
  /** npm package the scaffold imports from (e.g. `"harness-one"`, `"@harness-one/devkit"`). */
  readonly pkg: string;
  /**
   * Subpath under the package, WITHOUT the package name prefix. Empty string
   * means the root export. For `harness-one/core`, pkg=`"harness-one"`,
   * subpath=`"core"`.
   */
  readonly subpath: string;
}

/**
 * For each CLI-exposed module, the set of package/subpath combinations the
 * generated scaffold imports from. The parser test verifies every entry here
 * is still present in its target package's exports map.
 *
 * Entries with pkg = `"harness-one"` are checked against
 * `packages/core/package.json` → `exports`. Entries with pkg =
 * `"@harness-one/devkit"` are checked against `packages/devkit/package.json`
 * → `exports` (root-only for now). Other `@harness-one/<x>` packages export
 * only the root entry.
 */
export const SUBPATH_MAP: Record<ModuleName, SubpathRef[]> = {
  core: [{ pkg: 'harness-one', subpath: 'core' }],
  prompt: [{ pkg: 'harness-one', subpath: 'prompt' }],
  context: [
    { pkg: 'harness-one', subpath: 'context' },
    { pkg: 'harness-one', subpath: 'core' },
  ],
  tools: [{ pkg: 'harness-one', subpath: 'tools' }],
  guardrails: [{ pkg: 'harness-one', subpath: 'guardrails' }],
  observe: [{ pkg: 'harness-one', subpath: 'observe' }],
  session: [{ pkg: 'harness-one', subpath: 'session' }],
  memory: [{ pkg: 'harness-one', subpath: 'memory' }],
  eval: [{ pkg: '@harness-one/devkit', subpath: '' }],
  orchestration: [{ pkg: 'harness-one', subpath: 'orchestration' }],
  rag: [
    { pkg: 'harness-one', subpath: 'rag' },
    { pkg: 'harness-one', subpath: 'core' },
  ],
  evolve: [
    { pkg: '@harness-one/devkit', subpath: '' },
    { pkg: 'harness-one', subpath: 'evolve-check' },
  ],
};
