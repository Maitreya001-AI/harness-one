/**
 * `run_tests` tool — wraps `shell` for the project's test runner.
 *
 * Picks the runner from explicit input or by inspecting `package.json`:
 *   - `pnpm` / `npm` / `yarn` test (Node projects)
 *   - `pytest` (Python projects with `pyproject.toml` or `requirements.txt`)
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ToolCapability,
  defineTool,
  toolError,
} from 'harness-one/tools';
import type { ToolDefinition, ToolResult } from 'harness-one/tools';

import type { ToolContext } from './context.js';

interface RunTestsInput {
  /** Explicit runner; defaults to auto-detect. */
  readonly runner?: 'pnpm' | 'npm' | 'yarn' | 'pytest';
  /** Extra args to pass to the runner. */
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface RunTestsOptions {
  readonly defaultTimeoutMs?: number;
  /**
   * Required: a function that runs a shell command. Wired to the same shell
   * tool factory at agent build time so the same allowlist + dry-run +
   * approval policy applies.
   */
  readonly runShell: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
  }) => Promise<ToolResult>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export function defineRunTestsTool(
  ctx: ToolContext,
  options: RunTestsOptions,
): ToolDefinition<RunTestsInput> {
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return defineTool<RunTestsInput>({
    name: 'run_tests',
    description:
      'Run the project test runner (pnpm/npm/yarn/pytest). Auto-detects unless `runner` is set. ' +
      'Returns full stdout/stderr capped by the underlying shell limits.',
    capabilities: [ToolCapability.Shell],
    parameters: {
      type: 'object',
      properties: {
        runner: { type: 'string', enum: ['pnpm', 'npm', 'yarn', 'pytest'] },
        args: { type: 'array', items: { type: 'string' } },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 30 * 60_000 },
      },
      additionalProperties: false,
    },
    async execute(params) {
      const runner = params.runner ?? (await detectRunner(ctx.workspace));
      if (!runner) {
        return toolError(
          'Could not auto-detect test runner',
          'not_found',
          'Set `runner` explicitly or add package.json / pyproject.toml',
        );
      }
      const args = baseArgsForRunner(runner, params.args ?? []);
      const timeoutMs = Math.min(params.timeoutMs ?? defaultTimeout, 30 * 60_000);
      return options.runShell({ command: runner, args, timeoutMs });
    },
  });
}

export async function detectRunner(workspace: string): Promise<RunTestsInput['runner'] | undefined> {
  const candidates: Array<{ file: string; runner: RunTestsInput['runner'] }> = [
    { file: 'pnpm-lock.yaml', runner: 'pnpm' },
    { file: 'yarn.lock', runner: 'yarn' },
    { file: 'package-lock.json', runner: 'npm' },
    { file: 'package.json', runner: 'npm' },
    { file: 'pyproject.toml', runner: 'pytest' },
    { file: 'requirements.txt', runner: 'pytest' },
  ];
  for (const c of candidates) {
    try {
      await fs.access(path.join(workspace, c.file));
      return c.runner;
    } catch {
      /* keep trying */
    }
  }
  return undefined;
}

function baseArgsForRunner(
  runner: NonNullable<RunTestsInput['runner']>,
  extra: readonly string[],
): readonly string[] {
  switch (runner) {
    case 'pnpm':
    case 'npm':
    case 'yarn':
      return ['test', ...extra];
    case 'pytest':
      return [...extra];
  }
}
