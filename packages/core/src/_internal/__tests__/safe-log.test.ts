/**
 * Tests for safe-log primitive: default logger factory + safeWarn/safeError
 * helpers used as fallbacks throughout the monorepo.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createDefaultLogger,
  safeWarn,
  safeError,
} from '../safe-log.js';
import type { Logger } from '../../observe/logger.js';

function makeFakeLogger(): Logger & {
  calls: {
    debug: Array<[string, Record<string, unknown> | undefined]>;
    info: Array<[string, Record<string, unknown> | undefined]>;
    warn: Array<[string, Record<string, unknown> | undefined]>;
    error: Array<[string, Record<string, unknown> | undefined]>;
  };
} {
  const calls = {
    debug: [] as Array<[string, Record<string, unknown> | undefined]>,
    info: [] as Array<[string, Record<string, unknown> | undefined]>,
    warn: [] as Array<[string, Record<string, unknown> | undefined]>,
    error: [] as Array<[string, Record<string, unknown> | undefined]>,
  };
  const logger: Logger = {
    debug: (m, meta) => {
      calls.debug.push([m, meta]);
    },
    info: (m, meta) => {
      calls.info.push([m, meta]);
    },
    warn: (m, meta) => {
      calls.warn.push([m, meta]);
    },
    error: (m, meta) => {
      calls.error.push([m, meta]);
    },
    child: () => logger,
  };
  return Object.assign(logger, { calls });
}

describe('safe-log', () => {
  describe('createDefaultLogger', () => {
    it('redacts secret-looking keys in warn output', () => {
      // Capture console.log output because createLogger uses it by default.
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const logger = createDefaultLogger();
        logger.warn('something happened', { api_key: 'sk-abc', ok: 1 });
        expect(spy).toHaveBeenCalledTimes(1);
        const line = String(spy.mock.calls[0]![0]);
        expect(line).not.toContain('sk-abc');
        expect(line).toContain('[REDACTED]');
      } finally {
        spy.mockRestore();
      }
    });

    it('returns the same singleton instance across calls', () => {
      const a = createDefaultLogger();
      const b = createDefaultLogger();
      expect(a).toBe(b);
    });
  });

  describe('safeWarn', () => {
    it('does not throw when logger is undefined', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(() => safeWarn(undefined, 'hi')).not.toThrow();
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('uses the default logger when logger is undefined and redacts secrets', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        safeWarn(undefined, 'fallback', { token: 'secret-value' });
        expect(spy).toHaveBeenCalledTimes(1);
        const line = String(spy.mock.calls[0]![0]);
        expect(line).not.toContain('secret-value');
        expect(line).toContain('[REDACTED]');
      } finally {
        spy.mockRestore();
      }
    });

    it('forwards to logger.warn with msg and meta when logger is provided', () => {
      const fake = makeFakeLogger();
      const meta = { foo: 'bar' };
      safeWarn(fake, 'hello', meta);
      expect(fake.calls.warn).toHaveLength(1);
      expect(fake.calls.warn[0]![0]).toBe('hello');
      expect(fake.calls.warn[0]![1]).toBe(meta);
      // Should not touch other levels.
      expect(fake.calls.error).toHaveLength(0);
      expect(fake.calls.info).toHaveLength(0);
      expect(fake.calls.debug).toHaveLength(0);
    });

    it('forwards without meta when meta is omitted', () => {
      const fake = makeFakeLogger();
      safeWarn(fake, 'plain');
      expect(fake.calls.warn).toHaveLength(1);
      expect(fake.calls.warn[0]![0]).toBe('plain');
      expect(fake.calls.warn[0]![1]).toBeUndefined();
    });
  });

  describe('safeError', () => {
    it('does not throw when logger is undefined', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(() => safeError(undefined, 'boom')).not.toThrow();
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('uses the default logger when logger is undefined and redacts secrets', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        safeError(undefined, 'bad', { password: 'p@ss' });
        expect(spy).toHaveBeenCalledTimes(1);
        const line = String(spy.mock.calls[0]![0]);
        expect(line).not.toContain('p@ss');
        expect(line).toContain('[REDACTED]');
      } finally {
        spy.mockRestore();
      }
    });

    it('forwards to logger.error with msg and meta when logger is provided', () => {
      const fake = makeFakeLogger();
      const meta = { code: 500 };
      safeError(fake, 'kaboom', meta);
      expect(fake.calls.error).toHaveLength(1);
      expect(fake.calls.error[0]![0]).toBe('kaboom');
      expect(fake.calls.error[0]![1]).toBe(meta);
      expect(fake.calls.warn).toHaveLength(0);
    });

    it('forwards without meta when meta is omitted', () => {
      const fake = makeFakeLogger();
      safeError(fake, 'no-meta');
      expect(fake.calls.error).toHaveLength(1);
      expect(fake.calls.error[0]![0]).toBe('no-meta');
      expect(fake.calls.error[0]![1]).toBeUndefined();
    });
  });
});
