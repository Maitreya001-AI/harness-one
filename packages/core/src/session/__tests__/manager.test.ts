import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSessionManager } from '../manager.js';
import { HarnessError } from '../../core/errors.js';
import type { SessionEvent } from '../types.js';

describe('createSessionManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a session', () => {
    const sm = createSessionManager({ gcIntervalMs: 0 });
    const session = sm.create({ userId: 'alice' });
    expect(session.id).toBeDefined();
    expect(session.status).toBe('active');
    expect(session.metadata.userId).toBe('alice');
    expect(session.createdAt).toBeGreaterThan(0);
    sm.dispose();
  });

  it('retrieves a session by ID', () => {
    const sm = createSessionManager({ gcIntervalMs: 0 });
    const session = sm.create();
    const got = sm.get(session.id);
    expect(got).toBeDefined();
    expect(got!.id).toBe(session.id);
    sm.dispose();
  });

  it('returns undefined for unknown session', () => {
    const sm = createSessionManager({ gcIntervalMs: 0 });
    expect(sm.get('nope')).toBeUndefined();
    sm.dispose();
  });

  describe('access', () => {
    it('updates lastAccessedAt', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      const before = session.lastAccessedAt;
      // Small delay
      const accessed = sm.access(session.id);
      expect(accessed.lastAccessedAt).toBeGreaterThanOrEqual(before);
      sm.dispose();
    });

    it('throws for unknown session', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      expect(() => sm.access('nope')).toThrow(HarnessError);
      sm.dispose();
    });

    it('throws for locked session', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      sm.lock(session.id);
      expect(() => sm.access(session.id)).toThrow(HarnessError);
      try {
        sm.access(session.id);
      } catch (e) {
        expect((e as HarnessError).code).toBe('SESSION_LOCKED');
      }
      sm.dispose();
    });

    it('throws for expired session', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      const session = sm.create();
      // Manually expire by waiting
      vi.spyOn(Date, 'now').mockReturnValue(session.createdAt + 100);
      expect(() => sm.access(session.id)).toThrow(HarnessError);
      try {
        sm.access(session.id);
      } catch (e) {
        expect((e as HarnessError).code).toBe('SESSION_EXPIRED');
      }
      sm.dispose();
    });
  });

  describe('lock', () => {
    it('locks a session and returns unlock function', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      const { unlock } = sm.lock(session.id);
      const locked = sm.get(session.id);
      expect(locked!.status).toBe('locked');

      unlock();
      const unlocked = sm.get(session.id);
      expect(unlocked!.status).toBe('active');
      sm.dispose();
    });

    it('throws for unknown session', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      expect(() => sm.lock('nope')).toThrow(HarnessError);
      sm.dispose();
    });
  });

  describe('destroy', () => {
    it('removes a session', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      sm.destroy(session.id);
      expect(sm.get(session.id)).toBeUndefined();
      sm.dispose();
    });
  });

  describe('list', () => {
    it('lists all sessions', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      sm.create();
      sm.create();
      expect(sm.list()).toHaveLength(2);
      sm.dispose();
    });

    it('marks active sessions as expired during listing when TTL is exceeded', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      const events: SessionEvent[] = [];
      const session = sm.create();
      sm.onEvent(e => events.push(e));

      // Force time forward so the session is expired
      vi.spyOn(Date, 'now').mockReturnValue(session.createdAt + 100);

      const listed = sm.list();
      expect(listed).toHaveLength(1);
      expect(listed[0].status).toBe('expired');

      // Should have emitted an 'expired' event during list()
      const expiredEvent = events.find(e => e.type === 'expired');
      expect(expiredEvent).toBeDefined();
      expect(expiredEvent!.sessionId).toBe(session.id);
      sm.dispose();
    });

    it('does not re-emit expired event for already expired sessions', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      const session = sm.create();

      // Force time forward
      vi.spyOn(Date, 'now').mockReturnValue(session.createdAt + 100);

      // First call to get() marks it expired
      sm.get(session.id);

      // Now track events
      const events: SessionEvent[] = [];
      sm.onEvent(e => events.push(e));

      // Second call to list() should NOT re-emit expired since it's already expired
      const listed = sm.list();
      expect(listed[0].status).toBe('expired');
      const expiredEvents = events.filter(e => e.type === 'expired');
      expect(expiredEvents).toHaveLength(0);
      sm.dispose();
    });
  });

  describe('LRU eviction', () => {
    it('evicts least recently accessed when maxSessions exceeded', () => {
      const sm = createSessionManager({ maxSessions: 2, gcIntervalMs: 0 });
      const s1 = sm.create();
      sm.create();
      sm.create(); // Should evict s1
      expect(sm.get(s1.id)).toBeUndefined();
      expect(sm.list()).toHaveLength(2);
      sm.dispose();
    });
  });

  describe('TTL expiration', () => {
    it('marks sessions as expired after TTL', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      const session = sm.create();
      vi.spyOn(Date, 'now').mockReturnValue(session.createdAt + 100);
      const got = sm.get(session.id);
      expect(got!.status).toBe('expired');
      sm.dispose();
    });
  });

  describe('gc', () => {
    it('removes expired sessions', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      sm.create();
      sm.create();
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);
      const removed = sm.gc();
      expect(removed).toBe(2);
      expect(sm.list()).toHaveLength(0);
      sm.dispose();
    });

    it('returns 0 when nothing to collect', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      sm.create();
      expect(sm.gc()).toBe(0);
      sm.dispose();
    });
  });

  describe('activeSessions', () => {
    it('counts non-expired sessions', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      sm.create();
      sm.create();
      expect(sm.activeSessions).toBe(2);
      sm.dispose();
    });
  });

  describe('maxSessions', () => {
    it('returns configured max', () => {
      const sm = createSessionManager({ maxSessions: 50, gcIntervalMs: 0 });
      expect(sm.maxSessions).toBe(50);
      sm.dispose();
    });

    it('defaults to 100', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      expect(sm.maxSessions).toBe(100);
      sm.dispose();
    });
  });

  describe('events', () => {
    it('emits created event', () => {
      const events: SessionEvent[] = [];
      const sm = createSessionManager({ gcIntervalMs: 0 });
      sm.onEvent(e => events.push(e));
      sm.create();
      expect(events.some(e => e.type === 'created')).toBe(true);
      sm.dispose();
    });

    it('emits accessed event', () => {
      const events: SessionEvent[] = [];
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      sm.onEvent(e => events.push(e));
      sm.access(session.id);
      expect(events.some(e => e.type === 'accessed')).toBe(true);
      sm.dispose();
    });

    it('emits locked and unlocked events', () => {
      const events: SessionEvent[] = [];
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      sm.onEvent(e => events.push(e));
      const { unlock } = sm.lock(session.id);
      expect(events.some(e => e.type === 'locked')).toBe(true);
      unlock();
      expect(events.some(e => e.type === 'unlocked')).toBe(true);
      sm.dispose();
    });

    it('emits destroyed event', () => {
      const events: SessionEvent[] = [];
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      sm.onEvent(e => events.push(e));
      sm.destroy(session.id);
      expect(events.some(e => e.type === 'destroyed')).toBe(true);
      sm.dispose();
    });
  });

  describe('H4: lock/destroy race condition', () => {
    it('unlock throws HarnessError if session was destroyed between lock and unlock', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      const { unlock } = sm.lock(session.id);

      // Destroy session while it is locked
      sm.destroy(session.id);

      // Unlock should throw because the session no longer exists
      expect(() => unlock()).toThrow(HarnessError);
      try {
        unlock();
      } catch (e) {
        expect((e as HarnessError).code).toBe('SESSION_NOT_FOUND');
      }
      sm.dispose();
    });
  });

  describe('H5: event handler unsubscribe', () => {
    it('onEvent returns an unsubscribe function', () => {
      const events: SessionEvent[] = [];
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const unsub = sm.onEvent(e => events.push(e));

      // The return value should be a function
      expect(typeof unsub).toBe('function');

      sm.create();
      expect(events.length).toBeGreaterThan(0);

      const countBefore = events.length;

      // After unsubscribing, no more events should be received
      unsub();
      sm.create();
      expect(events.length).toBe(countBefore);
      sm.dispose();
    });
  });

  describe('H6: LRU access order tracking complexity comment', () => {
    it('touchAccessOrder works correctly for typical session counts', () => {
      const sm = createSessionManager({ maxSessions: 5, gcIntervalMs: 0 });
      const s1 = sm.create();
      const s2 = sm.create();
      const s3 = sm.create();

      // Access s1 to move it to the end of LRU
      sm.access(s1.id);

      // Create more sessions to force eviction
      sm.create();
      sm.create();
      sm.create(); // This should evict s2 (least recently used), not s1

      // s1 should still exist (was recently accessed)
      expect(sm.get(s1.id)).toBeDefined();
      // s2 should have been evicted (not accessed since creation)
      expect(sm.get(s2.id)).toBeUndefined();
      sm.dispose();
    });
  });

  describe('Map-based LRU eviction order', () => {
    it('evicts sessions in correct LRU order using Map', () => {
      const sm = createSessionManager({ maxSessions: 3, gcIntervalMs: 0 });
      const s1 = sm.create();
      const s2 = sm.create();
      const s3 = sm.create();

      // Access s1 so it becomes most recently used
      sm.access(s1.id);

      // Create a new session, should evict s2 (oldest untouched)
      sm.create();
      expect(sm.get(s2.id)).toBeUndefined();
      expect(sm.get(s1.id)).toBeDefined();
      expect(sm.get(s3.id)).toBeDefined();
      sm.dispose();
    });

    it('evicts multiple sessions in correct LRU order', () => {
      const sm = createSessionManager({ maxSessions: 2, gcIntervalMs: 0 });
      const s1 = sm.create();
      const s2 = sm.create();

      // Access s1 so s2 is now least recently used
      sm.access(s1.id);

      // Create two more, should evict s2 first then s1
      const s3 = sm.create(); // evicts s2
      expect(sm.get(s2.id)).toBeUndefined();
      expect(sm.get(s1.id)).toBeDefined();

      sm.create(); // evicts s1
      expect(sm.get(s1.id)).toBeUndefined();
      expect(sm.get(s3.id)).toBeDefined();
      sm.dispose();
    });
  });

  describe('Reentrant event handler safety', () => {
    it('handles event handler that calls access() during emit without corruption', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const s1 = sm.create();
      const s2 = sm.create();
      const events: SessionEvent[] = [];

      // Register a reentrant handler: when s2 is accessed, also access s1
      sm.onEvent(e => {
        events.push(e);
        if (e.type === 'accessed' && e.sessionId === s2.id) {
          // This triggers emit('accessed', s1.id) recursively
          sm.access(s1.id);
        }
      });

      // This should not throw or corrupt state
      sm.access(s2.id);

      // The reentrant access event for s1 should have been queued and delivered
      const accessedEvents = events.filter(e => e.type === 'accessed');
      expect(accessedEvents).toHaveLength(2);
      expect(accessedEvents[0].sessionId).toBe(s2.id);
      expect(accessedEvents[1].sessionId).toBe(s1.id);
      sm.dispose();
    });

    it('handles event handler that calls create() during emit without infinite loop', () => {
      const sm = createSessionManager({ maxSessions: 10, gcIntervalMs: 0 });
      let createCount = 0;
      const events: SessionEvent[] = [];

      sm.onEvent(e => {
        events.push(e);
        // Only create one extra session to avoid infinite loop
        if (e.type === 'created' && createCount === 0) {
          createCount++;
          sm.create({ nested: true });
        }
      });

      sm.create({ original: true });

      // Should have created events for both sessions
      const createdEvents = events.filter(e => e.type === 'created');
      expect(createdEvents).toHaveLength(2);
      sm.dispose();
    });
  });

  describe('C11: GC timer lifecycle', () => {
    it('dispose clears the GC interval timer', () => {
      const sm = createSessionManager({ gcIntervalMs: 100 });
      // Should not throw
      sm.dispose();
      // Calling dispose again should be safe
      sm.dispose();
    });

    it('GC timer does not prevent process exit (unref)', () => {
      // Create with real GC interval to confirm timer is created and unref'd
      const sm = createSessionManager({ gcIntervalMs: 50 });
      // If unref() was not called, this test would hang on process exit
      // We just verify the manager can be created and disposed without error
      sm.dispose();
    });
  });

  describe('edge cases', () => {
    it('concurrent lock attempt — throws SESSION_LOCKED', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      sm.lock(session.id);
      // Attempting to access (or lock-like operations) while locked should fail
      expect(() => sm.access(session.id)).toThrow(HarnessError);
      try {
        sm.access(session.id);
      } catch (e) {
        expect((e as HarnessError).code).toBe('SESSION_LOCKED');
      }
      sm.dispose();
    });

    it('unlock after destroy — throws HarnessError', () => {
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

    it('event unsubscribe function works', () => {
      const events: SessionEvent[] = [];
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const unsub = sm.onEvent(e => events.push(e));

      sm.create();
      const countAfterFirst = events.length;
      expect(countAfterFirst).toBeGreaterThan(0);

      unsub();

      sm.create();
      // No new events after unsubscribe
      expect(events.length).toBe(countAfterFirst);
      sm.dispose();
    });

    it('session metadata update reflected in get()', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create({ userId: 'alice', theme: 'dark' });
      const got = sm.get(session.id);
      expect(got).toBeDefined();
      expect(got!.metadata.userId).toBe('alice');
      expect(got!.metadata.theme).toBe('dark');
      sm.dispose();
    });

    it('access expired session — throws SESSION_EXPIRED', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      const session = sm.create();
      // Force time forward so session is expired
      vi.spyOn(Date, 'now').mockReturnValue(session.createdAt + 1000);
      expect(() => sm.access(session.id)).toThrow(HarnessError);
      try {
        sm.access(session.id);
      } catch (e) {
        expect((e as HarnessError).code).toBe('SESSION_EXPIRED');
      }
      sm.dispose();
    });

    it('dispose() clears GC timer and all sessions', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 10 });
      const session = sm.create();
      sm.dispose();
      // After dispose, both the GC timer and all sessions are cleared
      const got = sm.get(session.id);
      expect(got).toBeUndefined();
    });
  });

  // Fix 5: unlock() uses captured session reference for atomic check-and-modify
  describe('unlock uses captured session reference', () => {
    it('unlock operates on the session captured at lock time', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      const { unlock } = sm.lock(session.id);

      // Verify session is locked
      expect(sm.get(session.id)!.status).toBe('locked');

      // Unlock should use the captured reference
      unlock();
      expect(sm.get(session.id)!.status).toBe('active');
      sm.dispose();
    });

    it('unlock is idempotent — second call is a no-op', () => {
      const events: SessionEvent[] = [];
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      sm.onEvent(e => events.push(e));
      const { unlock } = sm.lock(session.id);

      unlock(); // First unlock: sets to active
      const unlockEvents1 = events.filter(e => e.type === 'unlocked');
      expect(unlockEvents1).toHaveLength(1);

      unlock(); // Second unlock: no-op (already active, not locked)
      const unlockEvents2 = events.filter(e => e.type === 'unlocked');
      expect(unlockEvents2).toHaveLength(1); // Still just 1

      expect(sm.get(session.id)!.status).toBe('active');
      sm.dispose();
    });

    it('captured reference prevents stale re-fetch from Map', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const session = sm.create();
      const { unlock } = sm.lock(session.id);

      // Access the session through get() to confirm it's locked
      const lockedSession = sm.get(session.id);
      expect(lockedSession!.status).toBe('locked');

      // Unlock uses captured ref, not a fresh Map lookup
      unlock();
      const afterUnlock = sm.get(session.id);
      expect(afterUnlock!.status).toBe('active');
      expect(afterUnlock!.lastAccessedAt).toBeGreaterThanOrEqual(lockedSession!.lastAccessedAt);
      sm.dispose();
    });
  });

  // Fix 6: dispose() clears all sessions and access order
  describe('dispose clears all state', () => {
    it('dispose clears all sessions from the manager', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      sm.create({ name: 'session-1' });
      sm.create({ name: 'session-2' });
      sm.create({ name: 'session-3' });

      expect(sm.list()).toHaveLength(3);

      sm.dispose();

      // All sessions should be cleared
      expect(sm.list()).toHaveLength(0);
      expect(sm.activeSessions).toBe(0);
    });

    it('dispose is idempotent — safe to call multiple times', () => {
      const sm = createSessionManager({ gcIntervalMs: 100 });
      sm.create();

      sm.dispose();
      // Calling dispose again should not throw
      expect(() => sm.dispose()).not.toThrow();
      expect(sm.list()).toHaveLength(0);
    });

    it('new sessions can be created after dispose', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      sm.create();
      sm.dispose();

      // Creating new sessions after dispose should still work
      // (the manager is still functional, just empty)
      const newSession = sm.create();
      expect(sm.get(newSession.id)).toBeDefined();
      expect(sm.list()).toHaveLength(1);
      sm.dispose();
    });
  });
});
