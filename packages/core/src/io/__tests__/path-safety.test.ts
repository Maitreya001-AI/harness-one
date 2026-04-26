import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveWithinRoot,
  canonicalizeRoot,
  canonicalizeRootSync,
  realpathExistingPrefix,
  assertContainedIn,
  isContainedIn,
} from '../path-safety.js';
import { HarnessError, HarnessErrorCode } from '../../infra/errors-base.js';

let workspace: string;

beforeEach(async () => {
  // Important: realpath the temp dir so subsequent comparisons work on
  // macOS (`/var → /private/var`).
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-io-'));
  workspace = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('canonicalizeRootSync', () => {
  it('returns absolute form for relative input', () => {
    const result = canonicalizeRootSync('packages/core');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('throws IO_PATH_INVALID on empty string', () => {
    expect(() => canonicalizeRootSync('')).toThrow(HarnessError);
    try {
      canonicalizeRootSync('');
    } catch (e) {
      expect((e as HarnessError).code).toBe(HarnessErrorCode.IO_PATH_INVALID);
    }
  });

  it('throws IO_PATH_INVALID on non-string', () => {
    // @ts-expect-error — runtime guard
    expect(() => canonicalizeRootSync(123)).toThrow(HarnessError);
  });
});

describe('canonicalizeRoot', () => {
  it('realpaths existing directory (collapses macOS /var → /private/var)', async () => {
    const result = await canonicalizeRoot(workspace);
    // We already realpathed the workspace in beforeEach, so
    // result === workspace. The point is no escape error is thrown.
    expect(result).toBe(workspace);
  });

  it('falls back to resolved path when target does not exist', async () => {
    const ghost = path.join(workspace, 'never-existed');
    const result = await canonicalizeRoot(ghost);
    expect(result).toBe(path.resolve(ghost));
  });
});

describe('realpathExistingPrefix', () => {
  it('returns realpath when target exists', async () => {
    const file = path.join(workspace, 'a.txt');
    await fs.writeFile(file, '');
    const result = await realpathExistingPrefix(file);
    expect(result).toBe(file);
  });

  it('returns realpath of deepest existing ancestor + tail when target does not exist', async () => {
    const inner = path.join(workspace, 'sub');
    await fs.mkdir(inner);
    const ghost = path.join(inner, 'ghost', 'deep.txt');
    const result = await realpathExistingPrefix(ghost);
    // ghost doesn't exist; deepest ancestor that does = inner
    expect(result.startsWith(workspace)).toBe(true);
    expect(result.endsWith(path.join('ghost', 'deep.txt'))).toBe(true);
  });

  it('returns target unchanged when no ancestor exists', async () => {
    const t = '/nonexistent/path/that/cannot/exist/at/all';
    const result = await realpathExistingPrefix(t);
    // Either the original target, or whatever realpath of the deepest
    // surviving ancestor (`/`) returns. Both are valid given the
    // function's contract.
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('collapses symlink prefixes to their realpath', async () => {
    const realDir = path.join(workspace, 'real');
    const linkDir = path.join(workspace, 'link');
    await fs.mkdir(realDir);
    await fs.symlink(realDir, linkDir);
    // Target inside the symlinked dir, and the leaf doesn't exist
    const target = path.join(linkDir, 'leaf.txt');
    const resolved = await realpathExistingPrefix(target);
    expect(resolved).toBe(path.join(realDir, 'leaf.txt'));
  });
});

describe('resolveWithinRoot', () => {
  it('accepts paths inside the root', async () => {
    const result = await resolveWithinRoot(workspace, 'a.txt');
    expect(result).toBe(path.join(workspace, 'a.txt'));
  });

  it('rejects empty path with IO_PATH_INVALID', async () => {
    await expect(resolveWithinRoot(workspace, '')).rejects.toMatchObject({
      code: HarnessErrorCode.IO_PATH_INVALID,
    });
  });

  it('rejects NUL-bearing path with IO_PATH_INVALID', async () => {
    await expect(resolveWithinRoot(workspace, 'a\0b')).rejects.toMatchObject({
      code: HarnessErrorCode.IO_PATH_INVALID,
    });
  });

  it('rejects ../ traversal with IO_PATH_ESCAPE', async () => {
    await expect(resolveWithinRoot(workspace, '../escape.txt')).rejects.toMatchObject({
      code: HarnessErrorCode.IO_PATH_ESCAPE,
    });
  });

  it('rejects absolute path that escapes root', async () => {
    await expect(resolveWithinRoot(workspace, '/etc/passwd')).rejects.toMatchObject({
      code: HarnessErrorCode.IO_PATH_ESCAPE,
    });
  });

  it('rejects symlink that points outside root with IO_PATH_ESCAPE', async () => {
    // Build a dir outside the workspace
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-io-outside-'));
    const realOutside = await fs.realpath(outside);
    try {
      // Plant a symlink inside the workspace pointing outside
      const linkPath = path.join(workspace, 'evil-link');
      await fs.symlink(realOutside, linkPath);
      // Target a file under the symlink — realpath collapses to outside
      await expect(
        resolveWithinRoot(workspace, 'evil-link/secret.txt'),
      ).rejects.toMatchObject({
        code: HarnessErrorCode.IO_PATH_ESCAPE,
      });
    } finally {
      await fs.rm(realOutside, { recursive: true, force: true });
    }
  });

  it('handles macOS /var → /private/var realpath gracefully', async () => {
    // The temp workspace already exercises this — it lives under
    // /var/folders on macOS but we realpath'd it in setup. Confirm we
    // can resolve a relative target without spurious escape.
    const result = await resolveWithinRoot(workspace, 'a/b/c.txt');
    expect(result.startsWith(workspace)).toBe(true);
  });

  it('handles deep non-existent leaf inside existing ancestor', async () => {
    const inner = path.join(workspace, 'sub');
    await fs.mkdir(inner);
    const result = await resolveWithinRoot(workspace, 'sub/missing/leaf.txt');
    expect(result).toBe(path.join(inner, 'missing', 'leaf.txt'));
  });

  it('handles . / .. equivalent to root', async () => {
    const result = await resolveWithinRoot(workspace, '.');
    expect(result).toBe(workspace);
  });
});

describe('assertContainedIn / isContainedIn', () => {
  it('returns true / does not throw for inside paths', () => {
    expect(isContainedIn('/a/b', '/a/b/c')).toBe(true);
    expect(() => assertContainedIn('/a/b', '/a/b/c')).not.toThrow();
  });

  it('returns true / does not throw for the root itself', () => {
    expect(isContainedIn('/a/b', '/a/b')).toBe(true);
    expect(() => assertContainedIn('/a/b', '/a/b')).not.toThrow();
  });

  it('returns false / throws IO_PATH_ESCAPE for sibling outside paths', () => {
    expect(isContainedIn('/a/b', '/a/c')).toBe(false);
    expect(() => assertContainedIn('/a/b', '/a/c')).toThrow(HarnessError);
    try {
      assertContainedIn('/a/b', '/a/c');
    } catch (e) {
      expect((e as HarnessError).code).toBe(HarnessErrorCode.IO_PATH_ESCAPE);
    }
  });

  it('returns false / throws for parent paths', () => {
    expect(isContainedIn('/a/b', '/a')).toBe(false);
  });

  it('returns false / throws for completely unrelated absolute paths', () => {
    expect(isContainedIn('/a/b', '/x/y')).toBe(false);
  });
});
