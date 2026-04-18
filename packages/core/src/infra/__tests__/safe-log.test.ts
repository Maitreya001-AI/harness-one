/**
 * Tests for safe-log primitive: default logger factory + safeWarn/safeError
 * helpers used as fallbacks throughout the monorepo.
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import {
  createDefaultLogger,
  isWarnActive,
  safeError,
  safeWarn,
} from '../safe-log.js';
import type { Logger } from '../../observe/logger.js';

/**
 * Build a `Logger` whose methods are `vi.fn()` spies. Using real spies
 * (instead of a hand-rolled calls array) means:
 *   - TypeScript enforces the Logger interface at build time, so drift in
 *     the canonical interface surfaces here.
 *   - Vitest's spy semantics (`mock.calls`, `toHaveBeenCalledWith`, …) work
 *     out of the box without custom matchers.
 */
function makeSpyLogger(): Logger & {
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
} {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { debug: Mock; info: Mock; warn: Mock; error: Mock };
  // The Logger contract requires a `child()` method. Return `this` so
  // downstream calls can still emit.
  (logger as Logger & { child: (meta: Record<string, unknown>) => Logger }).child = () => logger;
  return logger;
}

describe('safe-log', () => {
  describe('createDefaultLogger', () => {
    it('redacts secret-looking keys in warn output', () => {
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
      const logger = makeSpyLogger();
      const meta = { foo: 'bar' };
      safeWarn(logger, 'hello', meta);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith('hello', meta);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it('forwards without meta when meta is omitted', () => {
      const logger = makeSpyLogger();
      safeWarn(logger, 'plain');
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith('plain', undefined);
    });

    it('swallows a throwing user logger so a hot path never crashes', () => {
      const logger = makeSpyLogger();
      logger.warn.mockImplementation(() => {
        throw new Error('user logger blew up');
      });
      // The whole point of `safeWarn`: cost-tracker, retry-policy, etc. call
      // it from hot paths and must remain resilient against user-supplied
      // loggers that throw (broken transport, OOM, etc.).
      expect(() => safeWarn(logger, 'hot-path msg', { k: 1 })).not.toThrow();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('swallows when the default-logger fallback itself throws', () => {
      const spy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {
          throw new Error('console.log replaced with a thrower');
        });
      try {
        expect(() => safeWarn(undefined, 'hi')).not.toThrow();
      } finally {
        spy.mockRestore();
      }
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
      const logger = makeSpyLogger();
      const meta = { code: 500 };
      safeError(logger, 'kaboom', meta);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith('kaboom', meta);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('forwards without meta when meta is omitted', () => {
      const logger = makeSpyLogger();
      safeError(logger, 'no-meta');
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith('no-meta', undefined);
    });

    it('swallows a throwing user logger so a hot path never crashes', () => {
      const logger = makeSpyLogger();
      logger.error.mockImplementation(() => {
        throw new Error('user logger blew up');
      });
      expect(() => safeError(logger, 'hot-path err', { k: 1 })).not.toThrow();
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('swallows when the default-logger fallback itself throws', () => {
      const spy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {
          throw new Error('console.log replaced with a thrower');
        });
      try {
        expect(() => safeError(undefined, 'boom')).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('isWarnActive', () => {
    it('returns true for an undefined logger', () => {
      expect(isWarnActive(undefined)).toBe(true);
    });

    it('returns true for a logger without isWarnEnabled', () => {
      const logger = makeSpyLogger();
      expect(isWarnActive(logger)).toBe(true);
    });

    it('delegates to isWarnEnabled() when present', () => {
      const logger = makeSpyLogger();
      (logger as unknown as { isWarnEnabled: () => boolean }).isWarnEnabled = () => false;
      expect(isWarnActive(logger)).toBe(false);

      (logger as unknown as { isWarnEnabled: () => boolean }).isWarnEnabled = () => true;
      expect(isWarnActive(logger)).toBe(true);
    });
  });
});
