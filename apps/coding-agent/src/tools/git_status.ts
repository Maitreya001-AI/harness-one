/**
 * `git_status` tool — read-only snapshot of `git status --porcelain=v1`.
 *
 * Uses the shell tool seam so the tool inherits timeout, allowlist, and
 * dry-run handling consistently.
 *
 * Capability: `shell` (read-only git invocation).
 *
 * @module
 */

import {
  ToolCapability,
  defineTool,
  toolError,
  toolSuccess,
} from 'harness-one/tools';
import type { ToolDefinition, ToolResult } from 'harness-one/tools';

import type { ToolContext } from './context.js';

interface GitStatusInput {
  /** Optional pathspec, e.g. `"src/"`. */
  readonly pathspec?: string;
  readonly timeoutMs?: number;
}

interface GitStatusEntry {
  readonly status: string;
  readonly path: string;
}

export interface GitStatusOptions {
  readonly runShell: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
  }) => Promise<ToolResult>;
  readonly defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function defineGitStatusTool(
  _ctx: ToolContext,
  options: GitStatusOptions,
): ToolDefinition<GitStatusInput> {
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return defineTool<GitStatusInput>({
    name: 'git_status',
    description:
      'Run `git status --porcelain=v1` against the workspace. Returns parsed entries.',
    capabilities: [ToolCapability.Shell, ToolCapability.Readonly],
    parameters: {
      type: 'object',
      properties: {
        pathspec: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
      },
      additionalProperties: false,
    },
    async execute(params) {
      const args = ['status', '--porcelain=v1'];
      if (params.pathspec) args.push('--', params.pathspec);
      const timeoutMs = Math.min(params.timeoutMs ?? defaultTimeout, 120_000);

      const result = await options.runShell({ command: 'git', args, timeoutMs });
      if (result.kind !== 'success') return result;
      const data = result.data as {
        readonly stdout: string;
        readonly stderr: string;
        readonly exitCode: number | null;
      };
      if (data.exitCode !== 0) {
        return toolError(
          `git_status failed (exit ${data.exitCode ?? 'null'}): ${data.stderr.slice(0, 1024)}`,
          'internal',
          'Run `git status` manually to inspect the failure',
          false,
        );
      }
      const entries = parsePorcelain(data.stdout);
      return toolSuccess({ entries, count: entries.length });
    },
  });
}

export function parsePorcelain(stdout: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    if (rawLine.length < 4) continue;
    const status = rawLine.slice(0, 2);
    const rest = rawLine.slice(3);
    // Renames look like `R  old -> new`. Keep the new path; surface both via status code.
    const arrowIdx = rest.indexOf(' -> ');
    const filePath = arrowIdx >= 0 ? rest.slice(arrowIdx + 4) : rest;
    entries.push({ status, path: filePath });
  }
  return entries;
}
