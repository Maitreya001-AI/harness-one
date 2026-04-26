/**
 * Built-in fixture set for `harness-coding eval` smoke runs.
 *
 * Three small tasks that exercise the canonical agent paths:
 *  - read + summarise (no writes)
 *  - rename + replace (single-file write)
 *  - multi-file refactor (write + grep)
 *
 * Each fixture's verifier is independent of the LLM's reasoning — only
 * the resulting workspace state matters.
 *
 * @module
 */

import {
  allOf,
  changedFilesEqual,
  fileContains,
} from '../verifier.js';
import type { EvalFixture } from '../types.js';

const summariseFixture: EvalFixture = {
  id: 'read-summarise-001',
  name: 'Read README and report a summary',
  description: 'Agent must use read_file but never write_file.',
  workspace: {
    'README.md': '# Demo\nThe project lights one LED at boot.\n',
  },
  prompt:
    'Read README.md and produce a one-sentence summary of what the project does. Do not write any files.',
  budget: { tokens: 4_000, iterations: 4, durationMs: 30_000 },
  tags: ['readonly', 'smoke'],
  verify: async ({ result }) => {
    if (result.changedFiles.length !== 0) {
      return { pass: false, reason: `expected no writes; got ${result.changedFiles.join(',')}` };
    }
    if (result.summary.length === 0) {
      return { pass: false, reason: 'empty summary' };
    }
    return { pass: true };
  },
};

const renameFixture: EvalFixture = {
  id: 'rename-fn-001',
  name: 'Rename function in a single file',
  workspace: {
    'src/util.ts': 'export function oldName(x: number): number {\n  return x + 1;\n}\n',
  },
  prompt:
    'Open src/util.ts and rename the function `oldName` to `increment`. Use only write_file (no shell).',
  budget: { tokens: 4_000, iterations: 6, durationMs: 30_000 },
  tags: ['rename', 'single-file'],
  verify: allOf(
    changedFilesEqual(['src/util.ts']),
    fileContains('src/util.ts', 'increment'),
  ),
};

const refactorFixture: EvalFixture = {
  id: 'refactor-extract-001',
  name: 'Extract shared constant across two files',
  workspace: {
    'src/a.ts': 'export const ROUTE = "/api/v1";\n',
    'src/b.ts': 'export const PATH = "/api/v1";\n',
  },
  prompt:
    'Both src/a.ts and src/b.ts hard-code "/api/v1". Update src/a.ts so its constant reads from a new file src/route.ts that exports `API_ROUTE = "/api/v1"`. Leave src/b.ts unchanged.',
  budget: { tokens: 4_000, iterations: 8, durationMs: 60_000 },
  tags: ['refactor', 'multi-file'],
  verify: allOf(
    fileContains('src/route.ts', 'API_ROUTE'),
    fileContains('src/a.ts', 'route'),
  ),
};

export const builtinFixtures: readonly EvalFixture[] = Object.freeze([
  summariseFixture,
  renameFixture,
  refactorFixture,
]);
