import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRateLimiter } from '../rate-limiter.js';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Allows within limit ----

  it('allows requests within the configured limit', () => {
    const { guard } = createRateLimiter({ max: 3, windowMs: 1000 });

    expect(guard({ content: 'a' })).toEqual({ action: 'allow' });
    expect(guard({ content: 'b' })).toEqual({ action: 'allow' });
    expect(guard({ content: 'c' })).toEqual({ action: 'allow' });
  });

  it('allows exactly max requests then blocks max+1', () => {
    const { guard } = createRateLimiter({ max: 5, windowMs: 1000 });

    for (let i = 1; i <= 5; i++) {
      expect(guard({ content: `call-${i}` }).action).toBe('allow');
    }
    expect(guard({ content: 'call-6' }).action).toBe('block');
  });

  // ---- Blocks exceeding limit ----

  it('blocks requests exceeding the limit', () => {
    const { guard } = createRateLimiter({ max: 2, windowMs: 1000 });

    guard({ content: 'a' });
    guard({ content: 'b' });

    const result = guard({ content: 'c' });
    expect(result.action).toBe('block');
    if (result.action === 'block') {
      expect(result.reason).toContain('Rate limit exceeded');
    }
  });

  it('continues to block subsequent requests after limit exceeded', () => {
    const { guard } = createRateLimiter({ max: 1, windowMs: 1000 });

    guard({ content: 'a' });
    expect(guard({ content: 'b' }).action).toBe('block');
    expect(guard({ content: 'c' }).action).toBe('block');
    expect(guard({ content: 'd' }).action).toBe('block');
  });

  // ---- Window expiration resets counts ----

  it('allows again after the window expires', () => {
    const { guard } = createRateLimiter({ max: 1, windowMs: 1000 });

    guard({ content: 'a' });
    expect(guard({ content: 'b' }).action).toBe('block');

    vi.advanceTimersByTime(1001);
    expect(guard({ content: 'c' }).action).toBe('allow');
  });

  it('resets fully after window: allows up to max again', () => {
    const { guard } = createRateLimiter({ max: 2, windowMs: 1000 });

    // Fill window
    guard({ content: 'a' });
    guard({ content: 'b' });
    expect(guard({ content: 'c' }).action).toBe('block');

    // Advance past window
    vi.advanceTimersByTime(1001);

    // Fresh window
    expect(guard({ content: 'd' }).action).toBe('allow');
    expect(guard({ content: 'e' }).action).toBe('allow');
    expect(guard({ content: 'f' }).action).toBe('block');
  });

  it('sliding window: partial expiration within window', () => {
    const { guard } = createRateLimiter({ max: 2, windowMs: 1000 });

    // t=0: request 1
    guard({ content: 'a' });

    // t=500: request 2
    vi.advanceTimersByTime(500);
    guard({ content: 'b' });

    // t=500: blocked (2 requests within 1000ms window)
    expect(guard({ content: 'c' }).action).toBe('block');

    // t=1001: request 1 expires, request 2 still in window
    vi.advanceTimersByTime(501);
    expect(guard({ content: 'd' }).action).toBe('allow');
    // Now 2 in window again (request 2 at t=500 + request d at t=1001)
    expect(guard({ content: 'e' }).action).toBe('block');
  });

  // ---- Custom key function ----

  it('supports per-key rate limiting via keyFn', () => {
    const { guard } = createRateLimiter({
      max: 1,
      windowMs: 1000,
      keyFn: (ctx) => ctx.content,
    });

    expect(guard({ content: 'user1' }).action).toBe('allow');
    expect(guard({ content: 'user2' }).action).toBe('allow');
    expect(guard({ content: 'user1' }).action).toBe('block');
    expect(guard({ content: 'user2' }).action).toBe('block');
  });

  it('different keys do not interfere with each other', () => {
    const { guard } = createRateLimiter({
      max: 2,
      windowMs: 60_000,
      keyFn: (ctx) => ctx.content,
    });

    // Fill key "userA"
    expect(guard({ content: 'userA' }).action).toBe('allow');
    expect(guard({ content: 'userA' }).action).toBe('allow');
    expect(guard({ content: 'userA' }).action).toBe('block');

    // key "userB" is completely independent
    expect(guard({ content: 'userB' }).action).toBe('allow');
    expect(guard({ content: 'userB' }).action).toBe('allow');
    expect(guard({ content: 'userB' }).action).toBe('block');
  });

  it('uses _default key when no keyFn provided', () => {
    const { guard } = createRateLimiter({ max: 1, windowMs: 1000 });

    // All requests share the same default key
    expect(guard({ content: 'anything' }).action).toBe('allow');
    expect(guard({ content: 'different' }).action).toBe('block');
  });

  it('keyFn can use meta field for custom routing', () => {
    const { guard } = createRateLimiter({
      max: 1,
      windowMs: 1000,
      keyFn: (ctx) => String(ctx.meta?.userId ?? '_anon'),
    });

    expect(guard({ content: 'a', meta: { userId: 'u1' } }).action).toBe('allow');
    expect(guard({ content: 'b', meta: { userId: 'u2' } }).action).toBe('allow');
    expect(guard({ content: 'c', meta: { userId: 'u1' } }).action).toBe('block');
  });

  // ---- LRU key eviction ----

  it('evicts oldest keys when maxKeys exceeded', () => {
    const { guard } = createRateLimiter({
      max: 1,
      windowMs: 60_000,
      keyFn: (ctx) => ctx.content,
      maxKeys: 2,
    });

    guard({ content: 'key1' });
    guard({ content: 'key2' });
    guard({ content: 'key3' }); // evicts key1

    // key1 was evicted, should be allowed again (fresh bucket)
    expect(guard({ content: 'key1' }).action).toBe('allow');
  });

  it('LRU correctly tracks access order', () => {
    const { guard } = createRateLimiter({
      max: 1,
      windowMs: 60_000,
      keyFn: (ctx) => ctx.content,
      maxKeys: 3,
    });

    guard({ content: 'key1' });
    guard({ content: 'key2' });
    guard({ content: 'key3' });

    // All at limit
    expect(guard({ content: 'key1' }).action).toBe('block');
    expect(guard({ content: 'key2' }).action).toBe('block');
    expect(guard({ content: 'key3' }).action).toBe('block');

    // Adding key4 evicts LRU key (key1 was touched first in the block checks above)
    guard({ content: 'key4' });

    // key1 evicted -> allowed
    expect(guard({ content: 'key1' }).action).toBe('allow');
  });

  it('LRU handles high key churn correctly', () => {
    const { guard } = createRateLimiter({
      max: 1,
      windowMs: 60_000,
      keyFn: (ctx) => ctx.content,
      maxKeys: 5,
    });

    // Insert 10 keys, only last 5 survive
    for (let i = 0; i < 10; i++) {
      guard({ content: `churn_${i}` });
    }

    // Early keys evicted: allowed (fresh)
    expect(guard({ content: 'churn_0' }).action).toBe('allow');
    expect(guard({ content: 'churn_1' }).action).toBe('allow');

    // Recent keys still tracked: blocked
    expect(guard({ content: 'churn_8' }).action).toBe('block');
    expect(guard({ content: 'churn_9' }).action).toBe('block');
  });

  it('defaults maxKeys to 10_000', () => {
    // Just verify it works without specifying maxKeys and handles many keys
    const { guard } = createRateLimiter({
      max: 1,
      windowMs: 60_000,
      keyFn: (ctx) => ctx.content,
    });

    // Insert 100 distinct keys without error
    for (let i = 0; i < 100; i++) {
      expect(guard({ content: `key_${i}` }).action).toBe('allow');
    }
    // Verify tracked
    expect(guard({ content: 'key_99' }).action).toBe('block');
  });

  // ---- Name ----

  it('has name "rate-limiter"', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.name).toBe('rate-limiter');
  });

  // ---- Block reason format ----

  it('block reason includes rate limit details', () => {
    const { guard } = createRateLimiter({ max: 1, windowMs: 5000 });
    guard({ content: 'a' });
    const result = guard({ content: 'b' });

    expect(result.action).toBe('block');
    if (result.action === 'block') {
      expect(result.reason).toContain('1');
      expect(result.reason).toContain('5000');
    }
  });

  // ---- Performance ----

  it('handles many keys efficiently with Map-based O(1) LRU', () => {
    const { guard } = createRateLimiter({
      max: 100,
      windowMs: 60_000,
      keyFn: (ctx) => ctx.content,
      maxKeys: 10_000,
    });

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      guard({ content: `key_${i}` });
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });
});
