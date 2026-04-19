/**
 * Contract tests for the `harness-one/infra` barrel. Pins the exact
 * public surface that docs (README.md, README.zh-CN.md,
 * packages/core/README.md) have been promising. The barrel is
 * deliberately minimal: anything under `src/infra/` that is *not*
 * re-exported here stays private.
 */

import { describe, it, expect } from 'vitest';
import * as barrel from '../index.js';
import {
  createAdmissionController,
  unrefTimeout,
  unrefInterval,
} from '../index.js';

describe('harness-one/infra public surface', () => {
  it('exposes exactly the documented value symbols', () => {
    expect(Object.keys(barrel).sort()).toEqual(
      ['createAdmissionController', 'unrefInterval', 'unrefTimeout'].sort(),
    );
  });

  it('createAdmissionController returns a working controller', () => {
    const ac = createAdmissionController({ maxInflight: 2 });
    expect(typeof ac.acquire).toBe('function');
    expect(typeof ac.withPermit).toBe('function');
    expect(ac.inflight('tenant-a')).toBe(0);
    expect(ac.waiting('tenant-a')).toBe(0);
  });

  it('unrefTimeout returns a timer that fires and does not block exit', async () => {
    const fired = await new Promise<boolean>((resolve) => {
      const t = unrefTimeout(() => resolve(true), 1);
      expect(t).toBeDefined();
    });
    expect(fired).toBe(true);
  });

  it('unrefInterval returns a timer that fires and is clearable', async () => {
    let n = 0;
    const t = unrefInterval(() => {
      n += 1;
    }, 1);
    await new Promise((r) => setTimeout(r, 10));
    clearInterval(t);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});
