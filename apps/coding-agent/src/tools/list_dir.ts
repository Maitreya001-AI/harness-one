/**
 * `list_dir` tool — workspace-bounded directory listing.
 *
 * Capability: `filesystem` (read-only).
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ToolCapability,
  defineTool,
  toolError,
  toolSuccess,
} from 'harness-one/tools';
import type { ToolDefinition } from 'harness-one/tools';

import type { ToolContext } from './context.js';
import { resolveSafePath } from './paths.js';

interface ListDirInput {
  readonly path: string;
  /** Cap on entries returned. Defaults to 200. */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;

export function defineListDirTool(ctx: ToolContext): ToolDefinition<ListDirInput> {
  return defineTool<ListDirInput>({
    name: 'list_dir',
    description:
      'List entries in a workspace directory. Returns up to `limit` entries (default 200, max 1000). ' +
      'Each entry includes name and kind (file | directory | symlink | other).',
    capabilities: [ToolCapability.Filesystem, ToolCapability.Readonly],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path. Use "." for the root.', minLength: 1 },
        limit: {
          type: 'integer',
          description: 'Max entries to return (1..1000).',
          minimum: 1,
          maximum: MAX_LIMIT,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(params) {
      const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const safe = await resolveSafePath(ctx.workspace, params.path);
      try {
        const stat = await fs.stat(safe);
        if (!stat.isDirectory()) {
          return toolError(
            `Not a directory: ${path.relative(ctx.workspace, safe)}`,
            'validation',
            'Pass a directory path; use read_file for files',
          );
        }
        const dirents = await fs.readdir(safe, { withFileTypes: true });
        const truncated = dirents.length > limit;
        const sliced = dirents.slice(0, limit);
        const entries = sliced.map((d) => ({
          name: d.name,
          kind: kindOf(d),
        }));
        return toolSuccess({
          path: path.relative(ctx.workspace, safe),
          totalEntries: dirents.length,
          truncated,
          entries,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return toolError(
            `No such directory: ${params.path}`,
            'not_found',
            'Verify the path; use list_dir on the parent to discover it',
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        return toolError(`list_dir failed: ${msg}`, 'internal', 'Inspect the underlying filesystem error', false);
      }
    },
  });
}

function kindOf(d: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): string {
  if (d.isDirectory()) return 'directory';
  if (d.isSymbolicLink()) return 'symlink';
  if (d.isFile()) return 'file';
  return 'other';
}
