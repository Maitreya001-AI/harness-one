/**
 * Task-level checkpoint manager for the coding agent.
 *
 * Persists `TaskCheckpoint` snapshots into a `MemoryStore` so a crashed or
 * SIGINT-aborted run can resume exactly where it left off. Implements
 * the write strategy from DESIGN §3.7:
 *
 *   - every state transition writes a checkpoint
 *   - every Nth iteration writes a checkpoint (default 5)
 *   - every fs/shell side-effect should bracket itself in
 *     `recordToolCall(...)` (the call sites in S6/S7 do this)
 *
 * The schema-validation guard is hand-written rather than zod-dependent so
 * the package keeps zero new runtime deps. `validateMemoryEntry` from
 * `harness-one/memory` is layered on top by `parseStoredCheckpoint` to
 * reject corrupted JSON before we hand it back to the caller.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import type { MemoryEntry, MemoryStore } from 'harness-one/memory';
import { validateMemoryEntry } from 'harness-one/memory';

import type {
  BudgetLimits,
  BudgetState,
  TaskCheckpoint,
  TaskState,
  ToolCallEntry,
} from '../agent/types.js';
import { TASK_CHECKPOINT_SCHEMA_VERSION } from '../agent/types.js';
import { assertCheckpointShape } from './schema.js';

/** Default flush cadence: every 5 iterations. */
export const DEFAULT_FLUSH_EVERY_N_ITERATIONS = 5;

/** Memory key namespace. Tags are stable so listing is cheap. */
const KEY_PREFIX = 'coding-agent.task:';
const TAG_TASK = 'coding-agent';
const TAG_CHECKPOINT = 'task-checkpoint';

export interface CheckpointManagerOptions {
  readonly store: MemoryStore;
  /** Flush cadence; defaults to {@link DEFAULT_FLUSH_EVERY_N_ITERATIONS}. */
  readonly flushEveryNIterations?: number;
  readonly logger?: { warn: (m: string, meta?: Record<string, unknown>) => void };
}

export interface CheckpointManager {
  initial(input: {
    readonly taskId: string;
    readonly prompt: string;
    readonly workspace: string;
    readonly limits: BudgetLimits;
  }): TaskCheckpoint;
  /** Persist `next` if the manager's flush policy says so. Always persists on state change. */
  maybePersist(prev: TaskCheckpoint, next: TaskCheckpoint): Promise<TaskCheckpoint>;
  /** Force-persist regardless of flush policy. */
  persist(checkpoint: TaskCheckpoint): Promise<TaskCheckpoint>;
  load(taskId: string): Promise<TaskCheckpoint | null>;
  /** List checkpoint summaries for the resume picker. */
  list(limit?: number): Promise<readonly CheckpointSummary[]>;
  /** Append a new tool-call entry without bumping iteration semantics. */
  recordToolCall(checkpoint: TaskCheckpoint, entry: ToolCallEntry): TaskCheckpoint;
  /** Bump iteration counter + budget snapshot. */
  recordIteration(
    checkpoint: TaskCheckpoint,
    update: { readonly state?: TaskState; readonly budget: BudgetState },
  ): TaskCheckpoint;
}

export interface CheckpointSummary {
  readonly taskId: string;
  readonly state: TaskState;
  readonly iteration: number;
  readonly prompt: string;
  readonly lastUpdatedAt: number;
}

export function createCheckpointManager(options: CheckpointManagerOptions): CheckpointManager {
  const flushEvery = options.flushEveryNIterations ?? DEFAULT_FLUSH_EVERY_N_ITERATIONS;
  if (!Number.isInteger(flushEvery) || flushEvery <= 0) {
    throw new HarnessError(
      `flushEveryNIterations must be a positive integer; got ${flushEvery}`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Pass a positive integer or omit to use the default',
    );
  }

  const store = options.store;

  return {
    initial({ taskId, prompt, workspace, limits }): TaskCheckpoint {
      const now = Date.now();
      return {
        schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION,
        taskId,
        state: 'planning',
        iteration: 0,
        plan: { objective: prompt, steps: [], status: 'draft' },
        history: [],
        toolCallLog: [],
        budget: { tokensUsed: 0, iterations: 0, elapsedMs: 0, costUsd: 0 },
        limits,
        workspace,
        prompt,
        startedAt: now,
        lastUpdatedAt: now,
      };
    },

    async maybePersist(prev, next): Promise<TaskCheckpoint> {
      const stateChanged = prev.state !== next.state;
      const cadenceFlush = next.iteration > 0 && next.iteration % flushEvery === 0;
      const iterChanged = prev.iteration !== next.iteration;
      if (stateChanged || (cadenceFlush && iterChanged)) {
        return this.persist(next);
      }
      return next;
    },

    async persist(checkpoint): Promise<TaskCheckpoint> {
      assertCheckpointShape(checkpoint);
      const stamped: TaskCheckpoint = { ...checkpoint, lastUpdatedAt: Date.now() };
      const key = keyFor(stamped.taskId);
      const existing = await findEntryByKey(store, key);
      if (existing) {
        await store.update(existing.id, {
          content: JSON.stringify(stamped),
          metadata: metadataFor(stamped),
        });
      } else {
        await store.write({
          key,
          content: JSON.stringify(stamped),
          grade: 'critical',
          tags: [TAG_TASK, TAG_CHECKPOINT],
          metadata: metadataFor(stamped),
        });
      }
      return stamped;
    },

    async load(taskId): Promise<TaskCheckpoint | null> {
      const entry = await findEntryByKey(store, keyFor(taskId));
      if (!entry) return null;
      return parseStoredCheckpoint(entry);
    },

    async list(limit = 25): Promise<readonly CheckpointSummary[]> {
      const entries = await store.query({ tags: [TAG_CHECKPOINT], limit });
      const out: CheckpointSummary[] = [];
      for (const entry of entries) {
        try {
          const cp = parseStoredCheckpoint(entry);
          out.push({
            taskId: cp.taskId,
            state: cp.state,
            iteration: cp.iteration,
            prompt: cp.prompt,
            lastUpdatedAt: cp.lastUpdatedAt,
          });
        } catch (err) {
          options.logger?.warn?.('[coding-agent] skipping corrupt checkpoint entry', {
            entryId: entry.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return out;
    },

    recordToolCall(checkpoint, entry): TaskCheckpoint {
      return {
        ...checkpoint,
        toolCallLog: [...checkpoint.toolCallLog, entry],
        lastUpdatedAt: Date.now(),
      };
    },

    recordIteration(checkpoint, update): TaskCheckpoint {
      return {
        ...checkpoint,
        iteration: checkpoint.iteration + 1,
        ...(update.state !== undefined && { state: update.state }),
        budget: update.budget,
        lastUpdatedAt: Date.now(),
      };
    },
  };
}

/** Parse + validate a stored checkpoint entry. Throws on schema mismatch. */
export function parseStoredCheckpoint(entry: MemoryEntry): TaskCheckpoint {
  // Defence in depth: validate the entry envelope first (catches binary
  // corruption / incompatible store impl), then validate our payload.
  validateMemoryEntry(entry);
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.content);
  } catch (err) {
    throw new HarnessError(
      `Failed to parse task checkpoint JSON: ${err instanceof Error ? err.message : String(err)}`,
      HarnessErrorCode.MEMORY_CORRUPT,
      'Restore from a previous checkpoint or delete the entry',
    );
  }
  assertCheckpointShape(parsed);
  return parsed;
}

function keyFor(taskId: string): string {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new HarnessError(
      'taskId must be a non-empty string',
      HarnessErrorCode.CORE_INVALID_INPUT,
      'Pass a generated taskId from createTaskId()',
    );
  }
  return `${KEY_PREFIX}${taskId}`;
}

function metadataFor(checkpoint: TaskCheckpoint): Record<string, unknown> {
  return {
    coding_agent_task_id: checkpoint.taskId,
    coding_agent_state: checkpoint.state,
    coding_agent_iteration: checkpoint.iteration,
  };
}

async function findEntryByKey(store: MemoryStore, key: string): Promise<MemoryEntry | null> {
  // The MemoryStore interface doesn't ship a key→entry index, so fall back
  // to a tag-scoped query and filter in memory. The tag is small (one
  // entry per task) so the scan stays bounded.
  const entries = await store.query({ tags: [TAG_CHECKPOINT], limit: 10_000 });
  return entries.find((e) => e.key === key) ?? null;
}
