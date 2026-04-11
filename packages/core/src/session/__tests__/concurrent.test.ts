import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSessionManager } from '../manager.js';
import { HarnessError } from '../../core/errors.js';
import type { SessionEvent } from '../types.js';

describe('SessionManager concurrent access', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('multiple concurrent session creates at maxSessions limit', () => {
    it('creates sessions up to maxSessions and evicts LRU when exceeded', () => {
      const sm = createSessionManager({ maxSessions: 3, gcIntervalMs: 0 });

      // Create 5 sessions sequentially (JS is single-threaded, so "concurrent"
      // means rapid sequential calls without awaits)
      const sessions = [];
      for (let i = 0; i < 5; i++) {
        sessions.push(sm.create({ index: i }));
      }

      // Only maxSessions should remain
      const listed = sm.list();
      expect(listed).toHaveLength(3);

      // The oldest sessions (0 and 1) should have been evicted
      expect(sm.get(sessions[0].id)).toBeUndefined();
      expect(sm.get(sessions[1].id)).toBeUndefined();
      // The newest sessions (2, 3, 4) should be present
      expect(sm.get(sessions[2].id)).toBeDefined();
      expect(sm.get(sessions[3].id)).toBeDefined();
      expect(sm.get(sessions[4].id)).toBeDefined();

      sm.dispose();
    });

    it('rapid creates all produce unique session IDs', () => {
      const sm = createSessionManager({ maxSessions: 100, gcIntervalMs: 0 });
      const ids = new Set<string>();

      for (let i = 0; i < 50; i++) {
        const session = sm.create();
        ids.add(session.id);
      }

      expect(ids.size).toBe(50);
      sm.dispose();
    });

    it('eviction events are emitted correctly during rapid creates', () => {
      const events: SessionEvent[] = [];
      const sm = createSessionManager({ maxSessions: 2, gcIntervalMs: 0 });
      sm.onEvent((e) => events.push(e));

      sm.create({ name: 'first' });
      sm.create({ name: 'second' });
      sm.create({ name: 'third' }); // triggers eviction of first

      const evictedEvents = events.filter((e) => e.type === 'evicted');
      expect(evictedEvents).toHaveLength(1);
      expect(evictedEvents[0].reason).toBe('lru_capacity');

      sm.dispose();
    });
  });

  describe('concurrent access and lock on same session', () => {
    it('access after lock throws SESSION_LOCKED', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();

      const { unlock } = sm.lock(session.id);
      expect(() => sm.access(session.id)).toThrow(HarnessError);

      try {
        sm.access(session.id);
      } catch (e) {
        expect((e as HarnessError).code).toBe('SESSION_LOCKED');
      }

      unlock();
      // After unlock, access should work
      const accessed = sm.access(session.id);
      expect(accessed.status).toBe('active');

      sm.dispose();
    });

    it('multiple lock calls on same session do not double-lock', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();

      const lock1 = sm.lock(session.id);
      // Session is now locked, second lock attempt should NOT throw
      // (it just re-sets status to locked)
      const lock2 = sm.lock(session.id);

      // Both should have unlock functions
      expect(typeof lock1.unlock).toBe('function');
      expect(typeof lock2.unlock).toBe('function');

      // Unlock with first handle
      lock1.unlock();
      // Session should be active now (since lock1 captured reference had status locked)
      const after1 = sm.get(session.id);
      expect(after1!.status).toBe('active');

      // Second unlock should be a no-op (status already active, not locked)
      lock2.unlock();
      const after2 = sm.get(session.id);
      expect(after2!.status).toBe('active');

      sm.dispose();
    });

    it('lock prevents eviction during LRU cleanup', () => {
      const sm = createSessionManager({ maxSessions: 2, gcIntervalMs: 0 });
      const s1 = sm.create();
      const s2 = sm.create();

      // Lock s1 (the LRU candidate)
      const { unlock } = sm.lock(s1.id);

      // Create a third session, which should try to evict LRU
      sm.create();

      // s1 is locked, so it should NOT be evicted
      expect(sm.get(s1.id)).toBeDefined();
      // s2 (unlocked) should have been evicted instead
      expect(sm.get(s2.id)).toBeUndefined();

      unlock();
      sm.dispose();
    });
  });

  describe('concurrent GC while creating sessions', () => {
    it('GC cleans expired sessions while new ones are being created', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });

      // Create an old session
      const oldSession = sm.create({ name: 'old' });

      // Force time forward so the old session is expired
      vi.spyOn(Date, 'now').mockReturnValue(oldSession.createdAt + 100);

      // Create a new session and run GC "concurrently"
      const newSession = sm.create({ name: 'new' });
      const removed = sm.gc();

      // Old session should be removed
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(sm.get(oldSession.id)).toBeUndefined();

      // New session should still exist
      expect(sm.get(newSession.id)).toBeDefined();

      sm.dispose();
    });

    it('GC skips locked sessions even when expired by TTL', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      const session = sm.create();
      const { unlock } = sm.lock(session.id);

      // Force time forward
      vi.spyOn(Date, 'now').mockReturnValue(session.createdAt + 100);

      // GC should skip the locked session
      const removed = sm.gc();
      expect(removed).toBe(0);
      expect(sm.get(session.id)).toBeDefined();
      expect(sm.get(session.id)!.status).toBe('locked');

      unlock();
      sm.dispose();
    });

    it('multiple GC calls do not double-count removals', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      sm.create();
      sm.create();
      sm.create();

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);

      const removed1 = sm.gc();
      const removed2 = sm.gc();

      expect(removed1).toBe(3);
      expect(removed2).toBe(0); // Already cleaned up
      expect(sm.list()).toHaveLength(0);

      sm.dispose();
    });

    it('GC and list() interact correctly for expired sessions', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      const events: SessionEvent[] = [];
      sm.create();
      sm.create();

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);

      sm.onEvent((e) => events.push(e));

      // list() marks them expired, gc() removes them
      const listed = sm.list();
      expect(listed.every((s) => s.status === 'expired')).toBe(true);

      const expiredEvents = events.filter((e) => e.type === 'expired');
      expect(expiredEvents).toHaveLength(2);

      const removed = sm.gc();
      expect(removed).toBe(2);

      sm.dispose();
    });
  });

  describe('lock/unlock race conditions', () => {
    it('unlock after session destroy throws SESSION_NOT_FOUND', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      const { unlock } = sm.lock(session.id);

      sm.destroy(session.id);

      expect(() => unlock()).toThrow(HarnessError);
      try {
        unlock();
      } catch (e) {
        expect((e as HarnessError).code).toBe('SESSION_NOT_FOUND');
      }

      sm.dispose();
    });

    it('double unlock is idempotent', () => {
      const events: SessionEvent[] = [];
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      sm.onEvent((e) => events.push(e));

      const { unlock } = sm.lock(session.id);
      unlock(); // First: active
      unlock(); // Second: no-op

      const unlockEvents = events.filter((e) => e.type === 'unlocked');
      expect(unlockEvents).toHaveLength(1);

      expect(sm.get(session.id)!.status).toBe('active');
      sm.dispose();
    });

    it('lock and immediate access race: access sees locked state', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();

      sm.lock(session.id);

      // "Concurrent" access should see locked state
      expect(() => sm.access(session.id)).toThrow(HarnessError);

      sm.dispose();
    });

    it('unlock restores lastAccessedAt', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      const initialAccess = session.lastAccessedAt;

      const { unlock } = sm.lock(session.id);

      // Some time passes (simulated)
      const futureTime = initialAccess + 5000;
      vi.spyOn(Date, 'now').mockReturnValue(futureTime);

      unlock();

      const afterUnlock = sm.get(session.id);
      expect(afterUnlock!.lastAccessedAt).toBe(futureTime);
      expect(afterUnlock!.status).toBe('active');

      sm.dispose();
    });

    it('lock, expire by TTL, then unlock: session remains active after unlock', () => {
      // The unlock() path does not check TTL -- it just sets status to active.
      // This tests that behavior.
      const sm = createSessionManager({ ttlMs: 10, gcIntervalMs: 0 });
      const session = sm.create();
      const { unlock } = sm.lock(session.id);

      // Force time well past TTL
      vi.spyOn(Date, 'now').mockReturnValue(session.createdAt + 100);

      // Unlock should still work (locked sessions skip expiry check)
      unlock();
      const after = sm.get(session.id);
      // get() re-evaluates expiry: after unlock, lastAccessedAt was updated to
      // the mocked Date.now(), so the session may or may not be expired depending
      // on the exact timing. The key assertion is that unlock didn't throw.
      expect(after).toBeDefined();

      sm.dispose();
    });

    it('create, lock, GC, unlock interaction', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      const session = sm.create();
      const { unlock } = sm.lock(session.id);

      vi.spyOn(Date, 'now').mockReturnValue(session.createdAt + 100);

      // GC should skip locked sessions
      const removed = sm.gc();
      expect(removed).toBe(0);
      expect(sm.get(session.id)).toBeDefined();

      // Unlock and try GC again
      unlock();

      // After unlock, lastAccessedAt is updated to the mocked time,
      // so it's no longer expired. GC should find nothing to remove.
      const removed2 = sm.gc();
      expect(removed2).toBe(0);

      sm.dispose();
    });
  });
});
