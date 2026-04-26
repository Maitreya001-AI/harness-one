/**
 * Reusable verifier helpers — composable predicates fixtures can return.
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { VerifierContext, VerifierVerdict } from './types.js';

/** Pass when `path` exists and contains `text` verbatim. */
export function fileContains(filePath: string, text: string) {
  return async (ctx: VerifierContext): Promise<VerifierVerdict> => {
    const target = path.join(ctx.workspace, filePath);
    try {
      const content = await fs.readFile(target, 'utf8');
      if (content.includes(text)) return { pass: true };
      return { pass: false, reason: `expected "${text}" in ${filePath}; got: ${content.slice(0, 200)}` };
    } catch (err) {
      return {
        pass: false,
        reason: `${filePath} unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

/** Pass when `result.changedFiles` is the exact set provided. */
export function changedFilesEqual(expected: readonly string[]) {
  return async (ctx: VerifierContext): Promise<VerifierVerdict> => {
    const got = [...ctx.result.changedFiles].sort();
    const want = [...expected].sort();
    if (arraysEqual(got, want)) return { pass: true };
    return {
      pass: false,
      reason: `expected changedFiles ${JSON.stringify(want)}; got ${JSON.stringify(got)}`,
    };
  };
}

/** All-of combinator: fail on the first verifier that fails. */
export function allOf(
  ...verifiers: ReadonlyArray<(ctx: VerifierContext) => Promise<VerifierVerdict>>
) {
  return async (ctx: VerifierContext): Promise<VerifierVerdict> => {
    const failures: string[] = [];
    for (const v of verifiers) {
      const verdict = await v(ctx);
      if (!verdict.pass) failures.push(verdict.reason ?? 'unspecified');
    }
    if (failures.length === 0) return { pass: true };
    return { pass: false, reason: failures.join(' / ') };
  };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
