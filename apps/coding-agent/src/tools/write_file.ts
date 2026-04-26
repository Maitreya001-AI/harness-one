/**
 * `write_file` tool — atomic, workspace-bounded file writer.
 *
 * Hard guardrails: workspace containment + sensitive-path block (handled by
 * `resolveSafePath`). Soft guardrail: when the diff exceeds
 * `largeDiffLines`, the tool consults `ctx.requireApproval` (DESIGN §3.6).
 *
 * Honors `ctx.dryRun` — in dry-run mode no bytes are written but the tool
 * still returns the would-be diff stats so the agent can plan.
 *
 * Capability: `filesystem` (mutates state).
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

interface WriteFileInput {
  readonly path: string;
  readonly content: string;
  /** Whether to create parent directories if missing. */
  readonly createDirs?: boolean;
}

/** Lines threshold that triggers the soft-guardrail approval prompt. */
const LARGE_DIFF_LINES = 100;

export function defineWriteFileTool(ctx: ToolContext): ToolDefinition<WriteFileInput> {
  return defineTool<WriteFileInput>({
    name: 'write_file',
    description:
      'Write a UTF-8 file inside the workspace, creating it if needed. ' +
      'Refuses to write outside the workspace or to sensitive paths. ' +
      'Large diffs (>100 lines) require approval. In dry-run mode no bytes are written.',
    capabilities: [ToolCapability.Filesystem],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path.', minLength: 1 },
        content: { type: 'string', description: 'Full UTF-8 file content.' },
        createDirs: {
          type: 'boolean',
          description: 'Create missing parent directories. Default true.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async execute(params) {
      const safe = await resolveSafePath(ctx.workspace, params.path);
      const rel = path.relative(ctx.workspace, safe);
      const createDirs = params.createDirs ?? true;

      // Read existing content to compute diff stats — fail-loud only when
      // the read fails for reasons other than "file does not yet exist".
      let prev = '';
      let preExisted = true;
      try {
        prev = await fs.readFile(safe, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          preExisted = false;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          return toolError(
            `write_file failed to read prior content: ${msg}`,
            'internal',
            'Check that the path is readable',
            false,
          );
        }
      }

      const diff = computeDiffStats(prev, params.content);
      const totalDiffLines = diff.added + diff.removed;

      if (totalDiffLines >= LARGE_DIFF_LINES && ctx.requireApproval) {
        const decision = await ctx.requireApproval({
          toolName: 'write_file',
          arguments: { path: rel, addedLines: diff.added, removedLines: diff.removed },
          reason: `Large diff: +${diff.added} / -${diff.removed} lines`,
        });
        if (!decision.allow) {
          return toolError(
            `write_file denied by approval: ${decision.reason ?? 'no reason given'}`,
            'permission',
            'Adjust the approval policy or split the change into smaller writes',
            false,
          );
        }
      }

      if (ctx.dryRun) {
        return toolSuccess({
          path: rel,
          dryRun: true,
          preExisted,
          ...diff,
        });
      }

      try {
        if (createDirs) {
          await fs.mkdir(path.dirname(safe), { recursive: true });
        }
        await atomicWrite(safe, params.content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return toolError(
          `write_file failed: ${msg}`,
          'internal',
          'Inspect the underlying filesystem error',
          false,
        );
      }
      ctx.recordChangedFile?.(rel);
      return toolSuccess({
        path: rel,
        dryRun: false,
        preExisted,
        ...diff,
      });
    },
  });
}

/** Coarse line-count diff — enough to decide whether the change is "large". */
export function computeDiffStats(prev: string, next: string): { added: number; removed: number } {
  const prevLines = prev.length === 0 ? [] : prev.split('\n');
  const nextLines = next.length === 0 ? [] : next.split('\n');
  const prevSet = new Set(prevLines);
  const nextSet = new Set(nextLines);
  let added = 0;
  let removed = 0;
  for (const line of nextLines) if (!prevSet.has(line)) added += 1;
  for (const line of prevLines) if (!nextSet.has(line)) removed += 1;
  return { added, removed };
}

/** Atomic write via temp file + rename on the same filesystem. */
async function atomicWrite(target: string, data: string): Promise<void> {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, data, 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}
