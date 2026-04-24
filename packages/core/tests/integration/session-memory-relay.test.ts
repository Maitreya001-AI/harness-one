/**
 * D5 — SessionManager × filesystem MemoryStore × ContextRelay.
 *
 * Exercises three coupled concerns without mocking any harness code:
 *
 *  - Session TTL expiry between "runs" — sessions expire on lastAccessedAt
 *    age while memory entries on disk persist independently.
 *  - ContextRelay save/checkpoint round-trips: relay state is durable and
 *    readable across independent relay instances pointing at the same store.
 *  - `reconcileIndex()` recovers from a deliberately corrupted `_index.json`
 *    so the store returns to a consistent state without losing entries.
 *
 * TTL expiry uses `vi.useFakeTimers({ toFake: ['Date'] })` so virtual time
 * advances deterministically — real `setTimeout` sleeps would flake under
 * the parallel test-suite load.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSessionManager } from '../../src/session/manager.js';
import { createFileSystemStore } from '../../src/memory/fs-store.js';
import { createRelay } from '../../src/memory/relay.js';
import { HarnessError, HarnessErrorCode } from '../../src/core/errors.js';
import { useTempDir } from './fixtures/temp-dirs.js';

describe('integration/D5 · session TTL + fs memory store + relay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires the session after TTL while the relay state on disk survives untouched', async () => {
    // Mock only `Date` so SessionManager's `Date.now()`-based isExpired()
    // check can be advanced deterministically; leave `setTimeout` real so
    // the async filesystem code path isn't stalled waiting on virtual time.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: false });
    vi.setSystemTime(new Date(2025, 0, 1, 0, 0, 0));

    const dir = useTempDir('d5-ttl-');
    const store = createFileSystemStore({ directory: dir });
    const relay = createRelay({ store });

    // gcIntervalMs: 0 disables the auto-GC timer so the test doesn't leak
    // a setInterval handle into other suites (and doesn't race with the
    // manual TTL advance below).
    const ttlMs = 30_000;
    const sessions = createSessionManager({
      ttlMs,
      gcIntervalMs: 0,
      maxSessions: 4,
    });

    try {
      const session = sessions.create({ userId: 'alice' });

      // Run 1 — seed initial relay state while the session is fresh.
      sessions.access(session.id);
      await relay.save({
        progress: { step: 1 },
        artifacts: [],
        checkpoint: 'init',
        timestamp: Date.now(),
      });

      // Advance virtual time past half the TTL — session is still active
      // because `access()` below refreshes lastAccessedAt.
      vi.setSystemTime(Date.now() + ttlMs / 2);

      // Run 2 — advance progress; session still within TTL.
      sessions.access(session.id);
      await relay.checkpoint({ step: 2 });

      // Advance virtual time well past the TTL boundary.
      vi.setSystemTime(Date.now() + ttlMs * 2);

      // Run 3 — session access now throws SESSION_EXPIRED, but the relay
      // state on disk is untouched and another relay instance can load it.
      let caught: unknown;
      try {
        sessions.access(session.id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HarnessError);
      expect((caught as HarnessError).code).toBe(HarnessErrorCode.SESSION_EXPIRED);

      // A freshly-constructed relay over the same store reads back the last
      // saved checkpoint — proving the session lifecycle is orthogonal to
      // memory persistence.
      const reread = createRelay({ store });
      const state = await reread.load();
      expect(state).not.toBeNull();
      expect(state!.progress).toEqual({ step: 2 });
      // `relay.checkpoint()` stamps a `checkpoint_<ts>` marker over whatever
      // was saved earlier — asserting the prefix keeps the test resilient
      // against timestamp drift while still proving the update landed.
      expect(state!.checkpoint).toMatch(/^checkpoint_\d+$/);
    } finally {
      sessions.dispose();
    }
  });

  it('reconcileIndex() rebuilds a corrupted _index.json from on-disk entry files', async () => {
    const dir = useTempDir('d5-corrupt-');
    const store = createFileSystemStore({ directory: dir });

    // Write three independent entries through the normal code path.
    await store.write({ key: 'a', content: 'alpha', grade: 'useful' });
    await store.write({ key: 'b', content: 'beta', grade: 'critical' });
    await store.write({ key: 'c', content: 'gamma', grade: 'ephemeral' });

    const indexPath = join(dir, '_index.json');
    expect(existsSync(indexPath)).toBe(true);
    const originalIndex = readFileSync(indexPath, 'utf8');
    const originalKeys = JSON.parse(originalIndex).keys as Record<string, string>;
    expect(Object.keys(originalKeys).sort()).toEqual(['a', 'b', 'c']);

    // Nuke the index with garbage bytes that are neither valid JSON nor a
    // valid Index shape. Subsequent `write()` operations would throw
    // MEMORY_CORRUPT because write() reads the index inside its lock.
    writeFileSync(indexPath, 'not json \x00\x01\x02 definitely broken', 'utf8');

    // Queries that don't consult the index still observe the entries — the
    // query path walks `listEntryFiles()` directly.
    const pre = await store.query({});
    expect(pre.map((e) => e.key).sort()).toEqual(['a', 'b', 'c']);

    // Reconcile — scans every entry file, latest-updatedAt wins per key, and
    // writes a fresh index atomically.
    const reconcile = await store.reconcileIndex();
    expect(reconcile.scanned).toBe(3);
    expect(reconcile.keys).toBe(3);

    // Index is back to a parseable + structurally-valid state.
    const rebuilt = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      keys: Record<string, string>;
    };
    expect(Object.keys(rebuilt.keys).sort()).toEqual(['a', 'b', 'c']);

    // Writes work again (they read the index inside their lock, so a
    // successful write is the strongest post-reconciliation signal).
    const fresh = await store.write({ key: 'd', content: 'delta', grade: 'useful' });
    expect(fresh.key).toBe('d');

    const post = await store.query({});
    expect(post.map((e) => e.key).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
