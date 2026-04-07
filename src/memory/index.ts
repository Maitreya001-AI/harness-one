/**
 * Memory module — persistence, compaction, and cross-context relay.
 *
 * @module
 */

// Types
export type {
  MemoryGrade,
  MemoryEntry,
  MemoryFilter,
  CompactionPolicy,
  CompactionResult,
  RelayState,
} from './types.js';

// Store
export type { MemoryStore } from './store.js';
export { createInMemoryStore } from './store.js';

// File-system store
export { createFileSystemStore } from './fs-store.js';

// Relay
export type { ContextRelay } from './relay.js';
export { createRelay } from './relay.js';
