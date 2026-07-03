/**
 * Optimistic-lock (CAS) integrity across mixed mutation paths.
 *
 * `updateWithVersion` previously maintained its version index only for
 * CAS-path writes; plain `write()` / `update()` / `delete()` bypassed it,
 * so a plain-path writer could slip past a concurrent CAS caller without
 * a version conflict (a classic lost update). These tests pin the
 * bump-on-every-mutation contract plus the `getVersion()` accessor.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryStore } from '../store.js';
import type { MemoryStore } from '../store.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';

describe('in-memory store optimistic locking across mixed paths', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = createInMemoryStore();
  });

  it('getVersion returns 0 for a key never written', async () => {
    await expect(store.getVersion!('missing')).resolves.toBe(0);
  });

  it('plain write() advances the version', async () => {
    await store.write({ key: 'k', content: 'v1', grade: 'useful' });
    await expect(store.getVersion!('k')).resolves.toBe(1);
  });

  it('CAS with expectedVersion 0 conflicts after a plain write()', async () => {
    await store.write({ key: 'k', content: 'v1', grade: 'useful' });

    await expect(
      store.updateWithVersion!('k', 0, () => 'v2'),
    ).rejects.toMatchObject({ code: HarnessErrorCode.STORE_VERSION_CONFLICT });
  });

  it('plain update() invalidates an in-flight CAS (lost update prevented)', async () => {
    const entry = await store.write({ key: 'k', content: 'v1', grade: 'useful' });
    const v1 = await store.getVersion!('k');

    // A plain-path writer mutates the entry between the CAS caller's read
    // and its compare-and-swap.
    await store.update(entry.id, { content: 'plain-path-write' });

    await expect(
      store.updateWithVersion!('k', v1, () => 'cas-write'),
    ).rejects.toMatchObject({ code: HarnessErrorCode.STORE_VERSION_CONFLICT });

    // The CAS caller re-reads and retries with the fresh version — succeeds.
    const fresh = await store.getVersion!('k');
    const { newVersion } = await store.updateWithVersion!('k', fresh, () => 'cas-write');
    expect(newVersion).toBe(fresh + 1);
  });

  it('delete() advances the version so stale CAS callers conflict', async () => {
    const entry = await store.write({ key: 'k', content: 'v1', grade: 'useful' });
    const v1 = await store.getVersion!('k');
    await store.delete(entry.id);

    await expect(store.getVersion!('k')).resolves.toBe(v1 + 1);
    await expect(
      store.updateWithVersion!('k', v1, () => 'zombie'),
    ).rejects.toMatchObject({ code: HarnessErrorCode.STORE_VERSION_CONFLICT });
  });

  it('writeBatch() advances the version of every written key', async () => {
    await store.writeBatch!([
      { key: 'a', content: '1', grade: 'useful' },
      { key: 'b', content: '2', grade: 'useful' },
    ]);

    await expect(store.getVersion!('a')).resolves.toBe(1);
    await expect(store.getVersion!('b')).resolves.toBe(1);
  });

  it('setWithTtl keeps versions strictly monotonic (no reset to 1)', async () => {
    const entry = await store.write({ key: 'k', content: 'v1', grade: 'useful' }); // v1
    await store.delete(entry.id); // v2
    await store.setWithTtl!('k', 'ttl-value', 60_000); // v3 via write()

    const version = await store.getVersion!('k');
    expect(version).toBe(3);

    // A CAS caller holding the pre-delete version must conflict — a version
    // reset to 1 here would let it silently overwrite the TTL value.
    await expect(
      store.updateWithVersion!('k', 1, () => 'stale'),
    ).rejects.toMatchObject({ code: HarnessErrorCode.STORE_VERSION_CONFLICT });
  });

  it('updateWithVersion newVersion agrees with getVersion', async () => {
    const first = await store.updateWithVersion!<string>('k', 0, () => 'v1');
    expect(first.newVersion).toBe(1);
    await expect(store.getVersion!('k')).resolves.toBe(1);

    const second = await store.updateWithVersion!<string>('k', 1, (prev) => `${prev}+`);
    expect(second.newVersion).toBe(2);
    await expect(store.getVersion!('k')).resolves.toBe(2);
  });

  it('compact() advances versions of removed keys', async () => {
    await store.write({ key: 'old', content: 'x', grade: 'ephemeral' });
    const before = await store.getVersion!('old');

    // maxEntries: 0 forces removal of every unprotected entry.
    const result = await store.compact({ maxEntries: 0 });
    expect(result.removed).toBeGreaterThan(0);

    await expect(store.getVersion!('old')).resolves.toBe(before + 1);
  });

  it('CAS create on a never-written key still starts at version 1', async () => {
    const { newVersion } = await store.updateWithVersion!<{ n: number }>(
      'fresh',
      0,
      (prev) => ({ n: (prev?.n ?? 0) + 1 }),
    );
    expect(newVersion).toBe(1);
  });

  it('conflict error message names the key and both versions', async () => {
    await store.write({ key: 'k', content: 'v', grade: 'useful' });
    try {
      await store.updateWithVersion!('k', 0, () => 'x');
      expect.unreachable('expected STORE_VERSION_CONFLICT');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).message).toContain('"k"');
      expect((err as HarnessError).message).toContain('expected 0');
      expect((err as HarnessError).message).toContain('found 1');
    }
  });
});
