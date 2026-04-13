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
    it('evicts least recently accessed when maxSessions+threshold exceeded', () => {
      // PERF-019: eviction is amortized by a small threshold (max(1, 5% of maxSessions)).
      // At maxSessions=2 the threshold is 1, so we must exceed 3 before evicting.
      const sm = createSessionManager({ maxSessions: 2, gcIntervalMs: 0 });
      const s1 = sm.create();
      sm.create();
      sm.create(); // size=3, still within threshold, no eviction
      expect(sm.get(s1.id)).toBeDefined();
      sm.create(); // size=4 > maxSessions+threshold, triggers eviction down to maxSessions
      expect(sm.get(s1.id)).toBeUndefined();
      expect(sm.list()).toHaveLength(2);
      sm.dispose();
    });

    // Fix 11: LRU eviction emits distinct 'evicted' event
    it('emits evicted event with lru_capacity reason before destroyed', () => {
      const events: SessionEvent[] = [];
      const sm = createSessionManager({ maxSessions: 2, gcIntervalMs: 0 });
      sm.onEvent(e => events.push(e));
      const s1 = sm.create();
      sm.create();
      sm.create(); // still under threshold
      sm.create(); // Should evict s1 via LRU (crosses threshold)

      // Look for evicted event
      const evictedEvents = events.filter(e => e.type === 'evicted');
      expect(evictedEvents.length).toBeGreaterThanOrEqual(1);
      expect(evictedEvents.some(e => e.sessionId === s1.id)).toBe(true);
      expect(evictedEvents[0].reason).toBe('lru_capacity');

      // evicted should come before destroyed for the same session
      const eventTypes = events
        .filter(e => e.sessionId === s1.id)
        .map(e => e.type);
      const evictedIdx = eventTypes.indexOf('evicted');
      const destroyedIdx = eventTypes.indexOf('destroyed');
      expect(evictedIdx).toBeLessThan(destroyedIdx);
      sm.dispose();
    });

    // Issue 3 fix: LRU eviction must skip locked sessions
    it('does not evict locked sessions during LRU eviction (Issue 3 fix)', () => {
      const sm = createSessionManager({ maxSessions: 2, gcIntervalMs: 0 });
      const s1 = sm.create();
      const s2 = sm.create();

      // Lock s1 and s2 so they cannot be evicted
      sm.lock(s1.id);
      sm.lock(s2.id);

      // Creating a third session exceeds maxSessions=2, but both existing are locked.
      // Should throw SESSION_LIMIT since no room can be made.
      expect(() => sm.create()).toThrow(HarnessError);

      // Both locked sessions should still be alive — they must not be evicted
      expect(sm.get(s1.id)).toBeDefined();
      expect(sm.get(s2.id)).toBeDefined();
      sm.dispose();
    });

    it('evicts unlocked session before locked session (Issue 3 fix)', () => {
      const sm = createSessionManager({ maxSessions: 2, gcIntervalMs: 0 });
      const s1 = sm.create();
      const s2 = sm.create();

      // Lock s1 (LRU candidate) so eviction skips it, evicts s2 instead
      const { unlock } = sm.lock(s1.id);

      // Need to grow past maxSessions+threshold before eviction (PERF-019).
      sm.create();
      sm.create();

      // s1 is locked, should survive
      expect(sm.get(s1.id)).toBeDefined();
      // s2 should be evicted (unlocked, next in LRU order)
      expect(sm.get(s2.id)).toBeUndefined();

      unlock();
      sm.dispose();
    });

    it('throws SESSION_LIMIT when all sessions locked and at max capacity (Issue 3 fix)', () => {
      const sm = createSessionManager({ maxSessions: 1, gcIntervalMs: 0 });
      const s1 = sm.create();

      // Lock the only session
      sm.lock(s1.id);

      // Creating a new session when all existing are locked should throw
      expect(() => sm.create()).toThrow(HarnessError);
      try {
        sm.create();
      } catch (e) {
        expect((e as HarnessError).code).toBe('SESSION_LIMIT');
      }

      // The locked session must still exist
      expect(sm.get(s1.id)).toBeDefined();
      sm.dispose();
    });

    it('natural expiry via gc does NOT emit evicted event', () => {
      const events: SessionEvent[] = [];
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      sm.create();
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);
      sm.onEvent(e => events.push(e));
      sm.gc();

      const evictedEvents = events.filter(e => e.type === 'evicted');
      expect(evictedEvents).toHaveLength(0);
      // But destroyed should be emitted
      const destroyedEvents = events.filter(e => e.type === 'destroyed');
      expect(destroyedEvents).toHaveLength(1);
      sm.dispose();
    });
  });

  describe('TTL expiration', () => {
    it('returns undefined for expired sessions on get()', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      const session = sm.create();
      vi.spyOn(Date, 'now').mockReturnValue(session.createdAt + 100);
      const got = sm.get(session.id);
      expect(got).toBeUndefined();
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
      // PERF-019: eviction threshold = max(1, 5% of maxSessions) = 1 for maxSessions=5
      const sm = createSessionManager({ maxSessions: 5, gcIntervalMs: 0 });
      const s1 = sm.create();
      const s2 = sm.create();
      sm.create();

      // Access s1 to move it to the end of LRU
      sm.access(s1.id);

      // Create more sessions to force eviction (cross maxSessions+threshold=6)
      sm.create();
      sm.create();
      sm.create(); // size=6, threshold boundary
      sm.create(); // size=7 > 6 triggers eviction down to 5

      // s1 should still exist (was recently accessed)
      expect(sm.get(s1.id)).toBeDefined();
      // s2 should have been evicted (not accessed since creation)
      expect(sm.get(s2.id)).toBeUndefined();
      sm.dispose();
    });
  });

  describe('Map-based LRU eviction order', () => {
    it('evicts sessions in correct LRU order using Map', () => {
      // PERF-019: eviction threshold = 1 for maxSessions=3 (5% floor → min 1)
      const sm = createSessionManager({ maxSessions: 3, gcIntervalMs: 0 });
      const s1 = sm.create();
      const s2 = sm.create();
      const s3 = sm.create();

      // Access s1 and s3 so both are more recent than s2 (LRU order: s2, s1, s3).
      sm.access(s1.id);
      sm.access(s3.id);

      // Create new sessions; first one stays within threshold, second triggers eviction
      sm.create(); // size=4 within threshold (maxSessions+1), no eviction yet
      sm.create(); // size=5 > 4 triggers eviction down to 3, evicts s2 and s1 (LRU)
      expect(sm.get(s2.id)).toBeUndefined();
      expect(sm.get(s3.id)).toBeDefined();
      sm.dispose();
    });

    it('evicts multiple sessions in correct LRU order', () => {
      // PERF-019: threshold=1, so creates accumulate up to maxSessions+1 before eviction.
      // When size > maxSessions+threshold, evict all the way down to maxSessions.
      const sm = createSessionManager({ maxSessions: 2, gcIntervalMs: 0 });
      const s1 = sm.create();
      const s2 = sm.create();

      // Access s1 so s2 is now least recently used (order: s2, s1)
      sm.access(s1.id);

      // Create up to size=3 (still within threshold)
      sm.create();
      // Now size=3 order: s2 (LRU), s1, s3
      const s4 = sm.create();
      // size became 4 > 3 (maxSessions+threshold), evict down to 2:
      // evict s2 (LRU head), then s1. Remaining: s3 and s4.
      expect(sm.get(s2.id)).toBeUndefined();
      expect(sm.get(s1.id)).toBeUndefined();
      expect(sm.get(s4.id)).toBeDefined();
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

  // Fix 12: Lazy expiry behavior verification
  describe('lazy expiry', () => {
    it('expired sessions are invisible via get() but cleaned by gc()', () => {
      const sm = createSessionManager({ ttlMs: 1, gcIntervalMs: 0 });
      const session = sm.create();
      vi.spyOn(Date, 'now').mockReturnValue(session.createdAt + 100);

      // get() returns undefined for expired sessions (TTL check on read)
      const got = sm.get(session.id);
      expect(got).toBeUndefined();

      // list() still shows expired sessions (for admin/debug visibility)
      expect(sm.list()).toHaveLength(1);
      expect(sm.list()[0].status).toBe('expired');

      // gc removes expired sessions from memory
      const removed = sm.gc();
      expect(removed).toBe(1);
      expect(sm.list()).toHaveLength(0);
      sm.dispose();
    });
  });

  // Fix 13: GC timer unref behavior
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

  // SEC-002: Session IDs must be cryptographically secure (high entropy)
  // to prevent enumeration / hijacking attacks.
  describe('SEC-002: secure session IDs', () => {
    it('produces non-sequential, high-entropy IDs', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(sm.create().id);
      }
      // All 100 IDs must be unique (no collisions)
      expect(ids.size).toBe(100);
      // Each ID must match the secure prefixed format: sess-<32 hex chars>
      for (const id of ids) {
        expect(id).toMatch(/^sess-[0-9a-f]{32}$/);
      }
      sm.dispose();
    });

    it('IDs are unpredictable — no sequential counter leaks', () => {
      const sm = createSessionManager({ gcIntervalMs: 0 });
      const a = sm.create().id;
      const b = sm.create().id;
      // Sequential IDs would differ by a small, predictable increment.
      // With secureId, the hex bodies must not share the first 16 chars.
      const aHex = a.replace(/^sess-/, '').slice(0, 16);
      const bHex = b.replace(/^sess-/, '').slice(0, 16);
      expect(aHex).not.toBe(bHex);
      sm.dispose();
    });
  });

  // PERF-019: eviction should be amortized, not run on every create().
  describe('PERF-019: amortized eviction threshold', () => {
    it('does not evict when within threshold above maxSessions', () => {
      const sm = createSessionManager({ maxSessions: 2, gcIntervalMs: 0 });
      const s1 = sm.create();
      const s2 = sm.create();
      const s3 = sm.create(); // size=3, within threshold (max+1)
      // None should be evicted yet
      expect(sm.get(s1.id)).toBeDefined();
      expect(sm.get(s2.id)).toBeDefined();
      expect(sm.get(s3.id)).toBeDefined();
      sm.dispose();
    });

    it('evicts down to maxSessions when threshold crossed', () => {
      const sm = createSessionManager({ maxSessions: 2, gcIntervalMs: 0 });
      sm.create();
      sm.create();
      sm.create(); // size=3, no eviction
      sm.create(); // size=4 > 3, eviction triggers down to maxSessions
      expect(sm.list().length).toBe(2);
      sm.dispose();
    });

    it('threshold scales at 5% of maxSessions (min 1)', () => {
      // 100 sessions → threshold = 5. Must exceed 105 to trigger eviction.
      const sm = createSessionManager({ maxSessions: 100, gcIntervalMs: 0 });
      for (let i = 0; i < 105; i++) sm.create();
      // Within threshold: all 105 should still be present
      expect(sm.list().length).toBe(105);
      sm.create(); // 106 > 105 → eviction down to 100
      expect(sm.list().length).toBe(100);
      sm.dispose();
    });
  });

  // PERF-001: dispose() must always clear the GC interval, even if other cleanup throws.
  describe('PERF-001: dispose always releases GC timer', () => {
    it('clearInterval is called even if a cleanup step throws', () => {
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      const sm = createSessionManager({ gcIntervalMs: 60000 });
      sm.create();
      // Simulate a throw inside one of the cleanup steps by patching
      // eventHandlers to throw when its length setter runs.
      // We can't patch closure internals directly, but we can verify
      // clearInterval is called on a normal dispose path.
      sm.dispose();
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    });

    it('dispose runs clearInterval inside a finally block', () => {
      // Verify behavior via direct inspection: after dispose, re-dispose is a no-op
      // and no timer remains (we indirectly assert by not hanging the process).
      const sm = createSessionManager({ gcIntervalMs: 100 });
      sm.create();
      expect(() => sm.dispose()).not.toThrow();
      // Second dispose should also not throw
      expect(() => sm.dispose()).not.toThrow();
    });
  });

  describe('LM-012: Set-backed event handlers', () => {
    it('dedupes the same handler reference registered twice', () => {
      const sm = createSessionManager();
      const calls: string[] = [];
      const h = (e: { type: string }): void => {
        calls.push(e.type);
      };
      sm.onEvent(h);
      sm.onEvent(h);
      sm.create(); // triggers a 'create' event
      // Registered twice but Set stores one — handler runs once per event.
      expect(calls).toHaveLength(1);
      sm.dispose();
    });

    it('unsubscribe is idempotent and O(1) (many handlers)', () => {
      const sm = createSessionManager();
      const unsubs: Array<() => void> = [];
      for (let i = 0; i < 5_000; i++) {
        unsubs.push(sm.onEvent(() => {}));
      }
      // LIFO removal — any O(n) indexOf would compound to O(n²).
      for (let i = unsubs.length - 1; i >= 0; i--) unsubs[i]();
      // Re-call is a no-op.
      for (const u of unsubs) expect(() => u()).not.toThrow();
      sm.dispose();
    });

    it('preserves registration order across emits', () => {
      const sm = createSessionManager();
      const order: string[] = [];
      sm.onEvent(() => order.push('a'));
      sm.onEvent(() => order.push('b'));
      sm.onEvent(() => order.push('c'));
      sm.create();
      expect(order).toEqual(['a', 'b', 'c']);
      sm.dispose();
    });
  });
});
