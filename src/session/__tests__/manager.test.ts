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
});
