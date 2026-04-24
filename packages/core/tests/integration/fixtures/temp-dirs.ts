/**
 * Temp-dir helper for filesystem-backed integration tests.
 *
 * Creates a unique subdirectory under `os.tmpdir()` per call and registers an
 * afterEach cleanup. Returns the absolute path. Tests that need multiple
 * independent dirs call `useTempDir()` multiple times.
 */

import { afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function useTempDir(prefix = 'harness-one-integration-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Cleanup failure is non-fatal — the OS will eventually reclaim
      // /tmp. Suppressing keeps a hung FS from masking the real test
      // failure the consumer is investigating.
    }
  });
  return dir;
}
