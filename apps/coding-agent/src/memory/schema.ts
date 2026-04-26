/**
 * Hand-rolled schema guard for {@link TaskCheckpoint}.
 *
 * Throws `HarnessError(MEMORY_CORRUPT)` with an actionable diagnostic when
 * a checkpoint loaded from disk has the wrong shape. Avoids a zod runtime
 * dependency for the package.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';

import type { TaskCheckpoint, TaskState } from '../agent/types.js';
import { TASK_CHECKPOINT_SCHEMA_VERSION } from '../agent/types.js';

const STATES: readonly TaskState[] = [
  'planning',
  'executing',
  'testing',
  'reviewing',
  'done',
  'aborted',
];

/**
 * Throw if `value` is not a structurally-valid `TaskCheckpoint`.
 *
 * The check is intentionally narrow — it asserts the shape the
 * orchestrator depends on (state, iteration, plan, history, budget) but
 * does not deeply walk every nested array. Deep validation lives in the
 * upstream `validateMemoryEntry` envelope check.
 */
export function assertCheckpointShape(value: unknown): asserts value is TaskCheckpoint {
  if (value === null || typeof value !== 'object') {
    raise('Checkpoint must be an object');
  }
  const obj = value as Record<string, unknown>;
  if (obj['schemaVersion'] !== TASK_CHECKPOINT_SCHEMA_VERSION) {
    raise(`Unsupported schemaVersion: ${String(obj['schemaVersion'])}`);
  }
  assertString(obj['taskId'], 'taskId');
  assertString(obj['workspace'], 'workspace');
  assertString(obj['prompt'], 'prompt');
  assertEnum(obj['state'], STATES, 'state');
  assertNumber(obj['iteration'], 'iteration', { integer: true, min: 0 });
  assertNumber(obj['startedAt'], 'startedAt', { integer: true, min: 0 });
  assertNumber(obj['lastUpdatedAt'], 'lastUpdatedAt', { integer: true, min: 0 });
  assertObject(obj['plan'], 'plan');
  const plan = obj['plan'] as Record<string, unknown>;
  assertString(plan['objective'], 'plan.objective');
  if (!Array.isArray(plan['steps'])) raise('plan.steps must be an array');
  assertEnum(plan['status'], ['draft', 'committed'], 'plan.status');

  if (!Array.isArray(obj['history'])) raise('history must be an array');
  if (!Array.isArray(obj['toolCallLog'])) raise('toolCallLog must be an array');

  assertObject(obj['budget'], 'budget');
  const budget = obj['budget'] as Record<string, unknown>;
  for (const k of ['tokensUsed', 'iterations', 'elapsedMs', 'costUsd']) {
    assertNumber(budget[k], `budget.${k}`, { min: 0 });
  }
  assertObject(obj['limits'], 'limits');
  const limits = obj['limits'] as Record<string, unknown>;
  for (const k of ['tokens', 'iterations', 'durationMs']) {
    assertNumber(limits[k], `limits.${k}`, { min: 1 });
  }
}

function raise(msg: string): never {
  throw new HarnessError(
    `Corrupt task checkpoint: ${msg}`,
    HarnessErrorCode.MEMORY_CORRUPT,
    'Restore from a previous checkpoint or remove the corrupt entry',
  );
}

function assertString(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) raise(`${path} must be a non-empty string`);
}

function assertNumber(
  value: unknown,
  path: string,
  opts: { readonly integer?: boolean; readonly min?: number } = {},
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) raise(`${path} must be a finite number`);
  if (opts.integer && !Number.isInteger(value)) raise(`${path} must be an integer`);
  if (opts.min !== undefined && (value as number) < opts.min) {
    raise(`${path} must be >= ${opts.min}`);
  }
}

function assertObject(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    raise(`${path} must be a non-null object`);
  }
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): void {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    raise(`${path} must be one of ${allowed.join(', ')}`);
  }
}
