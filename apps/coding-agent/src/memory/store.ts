/**
 * Default `MemoryStore` factory for the coding agent.
 *
 * Resolves the storage directory (`~/.harness-coding/checkpoints` by
 * default) and creates a `FsMemoryStore`.
 *
 * @module
 */

import os from 'node:os';
import path from 'node:path';

import { createFileSystemStore } from 'harness-one/memory';
import type { FsMemoryStore } from 'harness-one/memory';

export interface CheckpointStoreOptions {
  /** Override the on-disk directory; defaults to `~/.harness-coding/checkpoints`. */
  readonly directory?: string;
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export function defaultCheckpointDir(): string {
  return path.join(os.homedir(), '.harness-coding', 'checkpoints');
}

export function createCheckpointStore(options?: CheckpointStoreOptions): FsMemoryStore {
  const directory = options?.directory ?? defaultCheckpointDir();
  return createFileSystemStore({
    directory,
    ...(options?.logger !== undefined && { logger: options.logger }),
  });
}
