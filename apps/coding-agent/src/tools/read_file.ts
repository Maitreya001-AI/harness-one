/**
 * `read_file` tool — read a workspace file, bounded by `maxBytes`.
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

interface ReadFileInput {
  readonly path: string;
  readonly maxBytes?: number;
}

/** Definition factory — bind once per agent instance. */
export function defineReadFileTool(ctx: ToolContext): ToolDefinition<ReadFileInput> {
  return defineTool<ReadFileInput>({
    name: 'read_file',
    description:
      'Read a UTF-8 file inside the workspace. ' +
      'Returns up to `maxBytes` (default 64KB) of text.',
    capabilities: [ToolCapability.Filesystem, ToolCapability.Readonly],
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative or absolute path to read.',
          minLength: 1,
        },
        maxBytes: {
          type: 'integer',
          description: 'Maximum bytes to read (1..262144).',
          minimum: 1,
          maximum: 262_144,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(params) {
      const cap = Math.min(params.maxBytes ?? 64 * 1024, ctx.maxOutputBytes);
      const safe = await resolveSafePath(ctx.workspace, params.path);
      try {
        const stat = await fs.stat(safe);
        if (!stat.isFile()) {
          return toolError(
            `Not a regular file: ${path.relative(ctx.workspace, safe)}`,
            'validation',
            'Pass a path to a file, not a directory or symlink target',
          );
        }
        // Read up to `cap + 1` bytes so we can detect truncation.
        const fh = await fs.open(safe, 'r');
        try {
          const buf = Buffer.alloc(cap + 1);
          const { bytesRead } = await fh.read(buf, 0, cap + 1, 0);
          const truncated = bytesRead > cap;
          const content = buf.slice(0, Math.min(bytesRead, cap)).toString('utf8');
          return toolSuccess({
            path: path.relative(ctx.workspace, safe),
            content,
            bytes: Math.min(bytesRead, cap),
            truncated,
            totalBytes: stat.size,
          });
        } finally {
          await fh.close();
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return toolError(
            `No such file: ${params.path}`,
            'not_found',
            'Verify the path; use list_dir to find it',
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        return toolError(`read_file failed: ${msg}`, 'internal', 'Inspect the underlying filesystem error', false);
      }
    },
  });
}
