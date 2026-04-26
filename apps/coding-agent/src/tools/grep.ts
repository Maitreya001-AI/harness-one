/**
 * `grep` tool — regex search across the workspace, bounded by result limit.
 *
 * Pure-Node implementation: no shell, no external `grep`/`rg` binary so the
 * tool stays portable and the result envelope is structured. Skips
 * `node_modules`, `.git`, and any directory or file the path-safety layer
 * flags as sensitive.
 *
 * Capability: `filesystem` + `readonly`.
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
import { safeReadFile } from 'harness-one/io';

import type { ToolContext } from './context.js';
import { isSensitivePath, resolveSafePath } from './paths.js';

interface GrepInput {
  readonly pattern: string;
  readonly path?: string;
  /** Maximum match records returned. */
  readonly limit?: number;
  /** When `true`, treat `pattern` as a fixed string (default `false`). */
  readonly literal?: boolean;
  /** When `true`, case-insensitive (default `false`). */
  readonly ignoreCase?: boolean;
}

interface MatchRecord {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_SCANNED = 5_000;
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
]);
/** Conservative safeguard against attacker-supplied catastrophic regexes. */
const MAX_PATTERN_LENGTH = 256;

export function defineGrepTool(ctx: ToolContext): ToolDefinition<GrepInput> {
  return defineTool<GrepInput>({
    name: 'grep',
    description:
      'Search workspace text files for a regex pattern. Skips node_modules, .git, dist, build, coverage. ' +
      'Returns up to `limit` match records (default 100, max 500).',
    capabilities: [ToolCapability.Filesystem, ToolCapability.Readonly],
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'JavaScript regex source (or literal when `literal: true`).',
          minLength: 1,
          maxLength: MAX_PATTERN_LENGTH,
        },
        path: { type: 'string', description: 'Workspace-relative subdirectory. Defaults to ".".' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        literal: { type: 'boolean' },
        ignoreCase: { type: 'boolean' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async execute(params, signal) {
      if (params.pattern.length > MAX_PATTERN_LENGTH) {
        return toolError(
          `Pattern exceeds ${MAX_PATTERN_LENGTH} chars`,
          'validation',
          'Shorten the regex or pre-filter with a more specific path',
        );
      }
      let regex: RegExp;
      try {
        const source = params.literal ? escapeRegex(params.pattern) : params.pattern;
        const flags = params.ignoreCase ? 'gi' : 'g';
        regex = new RegExp(source, flags);
      } catch (err) {
        return toolError(
          `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
          'validation',
          'Fix the pattern syntax (or set literal: true to escape it)',
        );
      }
      const start = await resolveSafePath(ctx.workspace, params.path ?? '.');
      const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

      const matches: MatchRecord[] = [];
      let filesScanned = 0;
      let truncated = false;

      const stack: string[] = [start];
      while (stack.length > 0) {
        if (signal?.aborted) {
          return toolError('grep aborted', 'timeout', 'Caller aborted before completion', true);
        }
        const dir = stack.pop() as string;
        let dirents;
        try {
          dirents = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const d of dirents) {
          if (signal?.aborted) {
            return toolError('grep aborted', 'timeout', 'Caller aborted before completion', true);
          }
          if (d.isDirectory()) {
            if (SKIP_DIR_NAMES.has(d.name)) continue;
            stack.push(path.join(dir, d.name));
            continue;
          }
          if (!d.isFile()) continue;
          const filePath = path.join(dir, d.name);
          const rel = path.relative(ctx.workspace, filePath);
          if (isSensitivePath(rel)) continue;
          filesScanned += 1;
          if (filesScanned > MAX_FILES_SCANNED) {
            truncated = true;
            break;
          }
          // safeReadFile (harness-one/io) handles the open-then-stat
          // sequencing internally so the TOCTOU race (CWE-367) is
          // impossible by construction. Skip the file when it exceeds
          // MAX_FILE_BYTES — for grep this is a soft skip, not an
          // error — by passing truncateOnOverflow: true and ignoring
          // truncated reads.
          let content: string;
          try {
            const result = await safeReadFile(filePath, {
              maxBytes: MAX_FILE_BYTES,
              requireFileKind: 'file',
              encoding: 'utf8',
              truncateOnOverflow: false,
            });
            content = result.content;
          } catch {
            // Oversize / non-regular / unreadable — skip, don't fail
            // the whole grep. Errors here are common (broken symlinks,
            // /proc-style virtual files on Linux, oversize log files
            // we deliberately skip via MAX_FILE_BYTES, etc.). All
            // failure modes collapse to "skip this file".
            continue;
          }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              matches.push({ path: rel, line: i + 1, text: clip(lines[i], 320) });
              if (matches.length >= limit) {
                truncated = true;
                break;
              }
            }
          }
          if (matches.length >= limit) break;
        }
        if (matches.length >= limit || filesScanned > MAX_FILES_SCANNED) break;
      }

      return toolSuccess({
        pattern: params.pattern,
        matches,
        truncated,
        filesScanned,
      });
    },
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
