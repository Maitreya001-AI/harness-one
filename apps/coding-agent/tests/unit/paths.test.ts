import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HarnessError, HarnessErrorCode } from 'harness-one/core';

import {
  canonicalizeWorkspace,
  isSensitivePath,
  resolveSafePath,
} from '../../src/tools/paths.js';

let workspace: string;
let outsideDir: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-paths-'));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-outside-'));
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

describe('canonicalizeWorkspace', () => {
  it('normalizes relative paths to absolute', () => {
    const here = canonicalizeWorkspace('.');
    expect(path.isAbsolute(here)).toBe(true);
  });

  it('rejects empty string', () => {
    expect(() => canonicalizeWorkspace('')).toThrowError(HarnessError);
  });

  it('rejects non-string', () => {
    expect(() => canonicalizeWorkspace(undefined as unknown as string)).toThrow();
  });
});

describe('isSensitivePath', () => {
  it.each([
    '.env',
    '.env.local',
    'src/.env',
    'id_rsa',
    'foo.key',
    'cert.pem',
    'wallet.pfx',
    'creds.p12',
    '.netrc',
    'home/.aws/credentials',
    'credentials',
  ])('flags %s', (p) => {
    expect(isSensitivePath(p)).toBe(true);
  });

  it.each(['src/index.ts', 'README.md', 'package.json', 'normal.txt'])(
    'allows %s',
    (p) => {
      expect(isSensitivePath(p)).toBe(false);
    },
  );
});

describe('resolveSafePath', () => {
  it('resolves a workspace-relative path', async () => {
    const target = path.join(workspace, 'a.txt');
    await fs.writeFile(target, 'hi');
    const safe = await resolveSafePath(workspace, 'a.txt');
    expect(safe).toBe(await fs.realpath(target));
  });

  it('resolves an absolute workspace-rooted path', async () => {
    const target = path.join(workspace, 'b.txt');
    await fs.writeFile(target, 'hi');
    const safe = await resolveSafePath(workspace, target);
    expect(safe).toBe(await fs.realpath(target));
  });

  it('rejects ../ traversal escape', async () => {
    let caught: unknown;
    try {
      await resolveSafePath(workspace, '../etc/passwd');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    // Path containment now uses the dedicated IO_PATH_ESCAPE code from
    // harness-one/io rather than the catch-all CORE_INVALID_INPUT — see
    // HARNESS_LOG HC-002 / HC-019 for the upstream primitive promotion.
    expect((caught as HarnessError).code).toBe(HarnessErrorCode.IO_PATH_ESCAPE);
  });

  it('rejects absolute path outside the workspace', async () => {
    await expect(resolveSafePath(workspace, outsideDir)).rejects.toThrow();
  });

  it('rejects sensitive filenames by default', async () => {
    const dotEnv = path.join(workspace, '.env');
    await fs.writeFile(dotEnv, 'SECRET=1');
    let caught: unknown;
    try {
      await resolveSafePath(workspace, '.env');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).code).toBe(HarnessErrorCode.GUARD_BLOCKED);
  });

  it('allows sensitive paths when allowSensitive=true', async () => {
    const dotEnv = path.join(workspace, '.env');
    await fs.writeFile(dotEnv, 'SECRET=1');
    const safe = await resolveSafePath(workspace, '.env', { allowSensitive: true });
    expect(safe).toBe(await fs.realpath(dotEnv));
  });

  it('rejects empty path', async () => {
    await expect(resolveSafePath(workspace, '')).rejects.toThrow();
  });

  it('rejects NUL character', async () => {
    await expect(resolveSafePath(workspace, 'foo\0bar')).rejects.toThrow();
  });

  it('blocks symlink escape via realpath check', async () => {
    const link = path.join(workspace, 'link');
    try {
      await fs.symlink(outsideDir, link);
    } catch {
      // Some filesystems disallow symlink creation; skip the assertion silently.
      return;
    }
    let caught: unknown;
    try {
      await resolveSafePath(workspace, 'link');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
  });
});
