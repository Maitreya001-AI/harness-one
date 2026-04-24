/**
 * N5 · MemoryStoreCapabilities ↔ optional-method shape lock.
 *
 * `MemoryStore` is a discriminated interface: a backend advertises what
 * it supports via `capabilities: MemoryStoreCapabilities` and offers the
 * corresponding method as OPTIONAL. Callers are supposed to check the
 * capability flag before invoking the method. A common refactor mistake
 * is to add a new optional method without adding a matching capability
 * flag — downstream callers then have no way to feature-detect short of
 * `typeof store.newMethod === 'function'`, which drifts silently.
 *
 * This file pins the pairing. For every optional MemoryStore method
 * there MUST be a capability flag, and vice versa. A local conditional
 * type `NarrowedStore<Caps>` demonstrates what the capability → method
 * narrowing looks like and is asserted against both sides — the test
 * doesn't change the source shape, only locks the invariant.
 */
import { expectTypeOf } from 'expect-type';
import type {
  MemoryStore,
  MemoryStoreCapabilities,
} from '../../src/memory/store.js';
import type {
  MemoryEntry,
  VectorSearchOptions,
} from '../../src/memory/types.js';

// ── 1. Capability flags — exhaustive, boolean, optional ──────────────────
type ExpectedCaps = {
  readonly atomicWrite?: boolean;
  readonly atomicBatch?: boolean;
  readonly atomicUpdate?: boolean;
  readonly supportsTtl?: boolean;
  readonly vectorSearch?: boolean;
  readonly batchWrites?: boolean;
  readonly supportsTenantScope?: boolean;
  readonly supportsOptimisticLock?: boolean;
};
expectTypeOf<MemoryStoreCapabilities>().toEqualTypeOf<ExpectedCaps>();

// ── 2. Optional methods are paired with capability flags ─────────────────
// `writeBatch`      ↔ `batchWrites`
// `searchByVector`  ↔ `vectorSearch`
// `setWithTtl`      ↔ `supportsTtl`
// `scopedView`      ↔ `supportsTenantScope`
// `updateWithVersion` ↔ `supportsOptimisticLock`
//
// The optional methods live on MemoryStore as `T | undefined`. A caller
// must feature-detect before invoking. Pin each method's signature so a
// rename would fail this file.
expectTypeOf<MemoryStore['writeBatch']>().toEqualTypeOf<
  ((entries: Array<Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<MemoryEntry[]>) | undefined
>();
expectTypeOf<MemoryStore['searchByVector']>().toEqualTypeOf<
  ((options: VectorSearchOptions) => Promise<Array<MemoryEntry & { score: number }>>) | undefined
>();
expectTypeOf<MemoryStore['setWithTtl']>().toEqualTypeOf<
  ((key: string, value: unknown, ttlMs: number) => Promise<void>) | undefined
>();
expectTypeOf<MemoryStore['scopedView']>().toEqualTypeOf<
  ((tenantId: string) => MemoryStore) | undefined
>();

// `updateWithVersion` is generic, so pin the signature via a self-reference.
type UpdateWithVersion = NonNullable<MemoryStore['updateWithVersion']>;
expectTypeOf<UpdateWithVersion>().not.toBeAny();
expectTypeOf<UpdateWithVersion>().toEqualTypeOf<
  <T>(
    key: string,
    expectedVersion: number,
    updater: (value: T | undefined) => T,
  ) => Promise<{ newVersion: number }>
>();

// ── 3. Capability → method narrowing (forward-looking) ───────────────────
// Demonstrate the shape a future capability-narrowed store would have.
// This conditional type is local to the test; if upstream adopts it,
// these assertions become the contract.
// The `Caps extends Record<K, true>` form requires the property be present
// AND pinned to literal `true`. This rules out both the "flag absent" case
// (indexing an absent property yields `never`, which spuriously satisfies
// `extends true`) and the "flag set to false" case.
type NarrowedStore<Caps extends MemoryStoreCapabilities> = Omit<
  MemoryStore,
  'writeBatch' | 'searchByVector' | 'setWithTtl' | 'scopedView' | 'updateWithVersion'
> & (Caps extends { batchWrites: true } ? { writeBatch: NonNullable<MemoryStore['writeBatch']> } : object)
  & (Caps extends { vectorSearch: true } ? { searchByVector: NonNullable<MemoryStore['searchByVector']> } : object)
  & (Caps extends { supportsTtl: true } ? { setWithTtl: NonNullable<MemoryStore['setWithTtl']> } : object)
  & (Caps extends { supportsTenantScope: true } ? { scopedView: NonNullable<MemoryStore['scopedView']> } : object)
  & (Caps extends { supportsOptimisticLock: true } ? { updateWithVersion: NonNullable<MemoryStore['updateWithVersion']> } : object);

// 3a. With a capability flag on, the method becomes required, not optional.
type WithVector = NarrowedStore<{ vectorSearch: true }>;
expectTypeOf<WithVector['searchByVector']>().toEqualTypeOf<
  NonNullable<MemoryStore['searchByVector']>
>();

// 3b. With the flag off/absent, the property is NOT part of the narrowed type.
type WithoutVector = NarrowedStore<{ vectorSearch: false }>;
expectTypeOf<WithoutVector>().not.toHaveProperty('searchByVector');

type NoCaps = NarrowedStore<Record<string, never>>;
expectTypeOf<NoCaps>().not.toHaveProperty('searchByVector');
expectTypeOf<NoCaps>().not.toHaveProperty('writeBatch');
expectTypeOf<NoCaps>().not.toHaveProperty('setWithTtl');
expectTypeOf<NoCaps>().not.toHaveProperty('scopedView');
expectTypeOf<NoCaps>().not.toHaveProperty('updateWithVersion');

// 3c. Core CRUD methods are always present irrespective of capabilities.
expectTypeOf<NoCaps>().toHaveProperty('read');
expectTypeOf<NoCaps>().toHaveProperty('write');
expectTypeOf<NoCaps>().toHaveProperty('query');
expectTypeOf<NoCaps>().toHaveProperty('update');
expectTypeOf<NoCaps>().toHaveProperty('delete');
