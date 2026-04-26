/**
 * Public barrel for the coding-agent memory layer.
 *
 * @module
 */

export {
  DEFAULT_FLUSH_EVERY_N_ITERATIONS,
  createCheckpointManager,
  parseStoredCheckpoint,
} from './checkpoint.js';
export type {
  CheckpointManager,
  CheckpointManagerOptions,
  CheckpointSummary,
} from './checkpoint.js';

export { compactTaskCheckpoints } from './compaction.js';
export type { CompactCheckpointsOptions } from './compaction.js';

export { assertCheckpointShape } from './schema.js';

export {
  createCheckpointStore,
  defaultCheckpointDir,
} from './store.js';
export type { CheckpointStoreOptions } from './store.js';
