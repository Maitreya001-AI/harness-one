/**
 * Tests for `session-gc.ts` — round-3 extraction from session-manager.
 */
import { describe, it, expect } from 'vitest';
import { startSessionGc } from '../session-gc.js';

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('startSessionGc', () => {
  it('invokes the callback at the configured interval', async () => {
    let calls = 0;
    const handle = startSessionGc(() => {
      calls++;
    }, 20);
    await sleep(85);
    handle.stop();
    const seen = calls;
    expect(seen).toBeGreaterThanOrEqual(2);
    await sleep(30);
    expect(calls).toBe(seen);
  });

  it('returns a no-op handle when intervalMs <= 0', async () => {
    let calls = 0;
    const handle = startSessionGc(() => {
      calls++;
    }, 0);
    await sleep(30);
    handle.stop(); // should not throw
    expect(calls).toBe(0);
  });

  it('swallows errors thrown by the callback', async () => {
    let callCount = 0;
    const handle = startSessionGc(() => {
      callCount++;
      throw new Error('boom');
    }, 10);
    await sleep(55);
    handle.stop();
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('stop() is idempotent', () => {
    const handle = startSessionGc(() => {}, 10);
    handle.stop();
    handle.stop();
    handle.stop();
  });
});
