/**
 * Dual-package hazard guard.
 *
 * A consumer can import `HarnessError` (and any other value export) through
 * three distinct resolution paths:
 *
 *   1. Root barrel        — `from 'harness-one'`          → `src/index.ts`
 *   2. Subpath barrel     — `from 'harness-one/core'`     → `src/core/index.ts`
 *   3. Deep import        — directly from the defining module
 *
 * If the class were ever re-declared or re-wrapped on any of these paths,
 * `instanceof HarnessError` would silently fail for consumers mixing paths
 * — a classic dual-package hazard. This test locks in the invariant that
 * all three paths resolve to the exact same class reference.
 *
 * Guards the bundled `dist/` output only indirectly; the primary regression
 * it catches is "someone redeclared the class during a refactor".
 */

import { describe, it, expect } from 'vitest';

import { HarnessError as FromRoot } from '../index.js';
import { HarnessError as FromSubpath } from '../core/index.js';
import { HarnessError as FromDeep, HarnessErrorCode } from '../core/errors.js';

describe('dual-package hazard — HarnessError identity', () => {
  it('root barrel and subpath barrel resolve to the same class', () => {
    expect(FromRoot).toBe(FromSubpath);
  });

  it('subpath barrel and deep import resolve to the same class', () => {
    expect(FromSubpath).toBe(FromDeep);
  });

  it('instanceof holds across every import path', () => {
    const err = new FromRoot('boom', { code: HarnessErrorCode.INVALID_CONFIG });
    expect(err).toBeInstanceOf(FromRoot);
    expect(err).toBeInstanceOf(FromSubpath);
    expect(err).toBeInstanceOf(FromDeep);
  });

  it('HarnessErrorCode enum values are reference-equal across re-export paths', async () => {
    const [root, subpath] = await Promise.all([
      import('../index.js'),
      import('../core/index.js'),
    ]);
    expect(root.HarnessErrorCode).toBe(subpath.HarnessErrorCode);
    // Must be a value import — if someone changes index.ts to `export type`,
    // Object.values() disappears at runtime and this breaks.
    expect(Object.values(root.HarnessErrorCode).length).toBeGreaterThan(0);
  });
});
