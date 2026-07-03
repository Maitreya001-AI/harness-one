/**
 * Unit tests for the real `optional-dep` synchronous lazy-loader.
 *
 * These exercise the ACTUAL `createRequire`-backed helpers (no seam mock), so
 * they verify the production resolution + error contract:
 * - an installed workspace peer resolves to a real module,
 * - a missing package produces an actionable `HarnessError` (install command),
 * - `tryLoadOptional` never throws.
 */
import { describe, it, expect } from 'vitest';

import { HarnessError, HarnessErrorCode } from 'harness-one/core';

import { requireForFeature, tryLoadOptional } from '../build-harness/optional-dep.js';

const ABSENT = '@harness-one/definitely-not-installed-xyz';

describe('optional-dep loader (real createRequire)', () => {
  describe('requireForFeature', () => {
    it('loads an installed workspace peer package', () => {
      const mod = requireForFeature<{ sealProviders: unknown }>('@harness-one/openai', {
        feature: "provider: 'openai'",
        install: 'npm install @harness-one/openai openai',
      });
      expect(mod).toBeTruthy();
      expect(typeof mod.sealProviders).toBe('function');
    });

    it('throws an actionable HarnessError naming the install command when the package is absent', () => {
      let caught: unknown;
      try {
        requireForFeature(ABSENT, {
          feature: "provider: 'ghost'",
          install: `npm install ${ABSENT}`,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(HarnessError);
      const err = caught as HarnessError;
      expect(err.code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
      // Message carries an action verb ("Install") + the package name so the
      // operator can fix it without a source dive (lint-error-messages contract).
      expect(err.message).toContain(ABSENT);
      expect(err.message.toLowerCase()).toContain('install');
      // Suggestion echoes the exact install command.
      expect(err.suggestion).toContain(`npm install ${ABSENT}`);
      // Underlying resolution failure preserved for debugging.
      expect(err.cause).toBeInstanceOf(Error);
    });
  });

  describe('tryLoadOptional', () => {
    it('returns the module namespace for an installed workspace peer', () => {
      const mod = tryLoadOptional<{ sealProviders: unknown }>('@harness-one/openai');
      expect(mod).not.toBeNull();
      expect(typeof mod!.sealProviders).toBe('function');
    });

    it('returns null (never throws) when the package is absent', () => {
      expect(tryLoadOptional(ABSENT)).toBeNull();
    });
  });
});
