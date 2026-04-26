/**
 * Build the canonical MVP tool set in one shot — read_file, write_file,
 * list_dir, grep, shell, run_tests, git_status.
 *
 * `shell` is constructed first so `run_tests` and `git_status` can reuse the
 * same allowlist + approval + dry-run pathway.
 *
 * @module
 */

import { ALL_TOOL_CAPABILITIES, createRegistry } from 'harness-one/tools';
import type { ToolDefinition, ToolRegistry, ToolResult } from 'harness-one/tools';

import type { ToolContext } from './context.js';
import { defineReadFileTool } from './read_file.js';
import { defineWriteFileTool } from './write_file.js';
import { defineListDirTool } from './list_dir.js';
import { defineGrepTool } from './grep.js';
import { defineShellTool, type ShellOptions } from './shell.js';
import { defineRunTestsTool } from './run_tests.js';
import { defineGitStatusTool } from './git_status.js';

export interface BuildToolsOptions {
  readonly ctx: ToolContext;
  readonly shell: ShellOptions;
}

export interface BuiltTools {
  readonly registry: ToolRegistry;
  readonly tools: readonly ToolDefinition<unknown>[];
}

/** Build the seven-tool MVP set + register it with a permissive registry. */
export function buildMvpToolSet(options: BuildToolsOptions): BuiltTools {
  const { ctx, shell } = options;

  const shellTool = defineShellTool(ctx, shell);

  const runShell = async (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
  }): Promise<ToolResult> => {
    return shellTool.execute({ command: input.command, args: input.args, timeoutMs: input.timeoutMs });
  };

  const runTests = defineRunTestsTool(ctx, { runShell });
  const gitStatus = defineGitStatusTool(ctx, { runShell });

  const tools: readonly ToolDefinition<unknown>[] = [
    defineReadFileTool(ctx) as ToolDefinition<unknown>,
    defineWriteFileTool(ctx) as ToolDefinition<unknown>,
    defineListDirTool(ctx) as ToolDefinition<unknown>,
    defineGrepTool(ctx) as ToolDefinition<unknown>,
    shellTool as ToolDefinition<unknown>,
    runTests as ToolDefinition<unknown>,
    gitStatus as ToolDefinition<unknown>,
  ];

  // Tools span readonly / filesystem / shell capabilities — open the
  // capability allowlist to all five so a fail-closed registry doesn't
  // refuse to register the shell tool. Guardrails enforce the actual policy.
  const registry = createRegistry({ allowedCapabilities: ALL_TOOL_CAPABILITIES });
  for (const t of tools) {
    registry.register(t as Parameters<typeof registry.register>[0]);
  }
  return { registry, tools };
}
