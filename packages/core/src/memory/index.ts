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
  VectorSearchOptions,
} from './types.js';

// Store
export type { MemoryStore } from './store.js';
export { createInMemoryStore } from './store.js';

// File-system store
export { createFileSystemStore } from './fs-store.js';

// File I/O primitives
export { createFileIO } from './fs-io.js';
export type { FileIO, Index } from './fs-io.js';

// Relay
export type { ContextRelay } from './relay.js';
export { createRelay } from './relay.js';
