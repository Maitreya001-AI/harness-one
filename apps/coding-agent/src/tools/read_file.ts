/**
 * `read_file` tool — read a workspace file, bounded by `maxBytes`.
 *
 * Capability: `filesystem` (read-only).
 *
 * @module
 */

import path from 'node:path';

import {
  ToolCapability,
  defineTool,
  toolError,
  toolSuccess,
} from 'harness-one/tools';
import type { ToolDefinition } from 'harness-one/tools';
import { safeReadFile } from 'harness-one/io';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

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
        // safeReadFile (harness-one/io) opens-then-stats the file
        // descriptor — TOCTOU-safe by construction (CWE-367 fix lives
        // upstream now). truncateOnOverflow lets us surface the same
        // "first N bytes + truncated flag" envelope the model expects.
        const result = await safeReadFile(safe, {
          maxBytes: cap,
          requireFileKind: 'file',
          encoding: 'utf8',
          truncateOnOverflow: true,
        });
        return toolSuccess({
          path: path.relative(ctx.workspace, safe),
          content: result.content,
          bytes: result.bytesRead,
          truncated: result.truncated,
          totalBytes: result.totalBytes,
        });
      } catch (err) {
        if (err instanceof HarnessError && err.code === HarnessErrorCode.IO_NOT_REGULAR_FILE) {
          return toolError(
            `Not a regular file: ${path.relative(ctx.workspace, safe)}`,
            'validation',
            'Pass a path to a file, not a directory or symlink target',
          );
        }
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
