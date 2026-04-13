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
export type { MemoryStore, MemoryStoreCapabilities } from './store.js';
export { createInMemoryStore } from './store.js';

// File-system store
export { createFileSystemStore } from './fs-store.js';

// File I/O primitives
export { createFileIO, validateEntryId } from './fs-io.js';
export type { FileIO, Index } from './fs-io.js';

// Relay
export type { ContextRelay } from './relay.js';
export { createRelay } from './relay.js';

// Schema guards for persistence boundaries. Use these in custom MemoryStore
// backends (Redis, Postgres, S3, …) to validate JSON parsed from the wire
// before treating it as typed data — prevents silent corruption on partial
// writes, schema drift, or byte-flip corruption. Every validator throws
// `HarnessError` with code `STORE_CORRUPTION` on shape mismatch.
export {
  validateMemoryEntry,
  validateIndex,
  validateRelayState,
  parseJsonSafe,
} from './_schemas.js';

// Testkit for third-party MemoryStore implementations.
export type { TestKitRunner } from './testkit.js';
export { runMemoryStoreConformance } from './testkit.js';
