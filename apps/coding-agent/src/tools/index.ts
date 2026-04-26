/**
 * Public barrel for the coding-agent tool definitions.
 *
 * @module
 */

export type { ToolContext } from './context.js';
export { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TOOL_TIMEOUT_MS } from './context.js';

export {
  canonicalizeWorkspace,
  canonicalizeWorkspaceAsync,
  isSensitivePath,
  resolveSafePath,
} from './paths.js';

export { defineReadFileTool } from './read_file.js';
export { computeDiffStats, defineWriteFileTool } from './write_file.js';
export { defineListDirTool } from './list_dir.js';
export { defineGrepTool } from './grep.js';
export { defineShellTool } from './shell.js';
export type { ShellOptions } from './shell.js';
export { defineRunTestsTool, detectRunner } from './run_tests.js';
export type { RunTestsOptions } from './run_tests.js';
export { defineGitStatusTool, parsePorcelain } from './git_status.js';
export type { GitStatusOptions } from './git_status.js';

export { buildMvpToolSet } from './registry.js';
export type { BuildToolsOptions, BuiltTools } from './registry.js';

export {
  createLspClient,
  createLspToolset,
} from './lsp/index.js';
export type {
  LspClient,
  LspClientOptions,
  LspToolset,
  LspToolsetOptions,
} from './lsp/index.js';
