import { describe, it, expect } from 'vitest';
import { createLogger, createSafeReplacer } from '../logger.js';

describe('logger hardening', () => {
  describe('isWarnEnabled level gate', () => {
    it('reflects the logger level', () => {
      expect(createLogger({ level: 'warn' }).isWarnEnabled?.()).toBe(true);
      expect(createLogger({ level: 'error' }).isWarnEnabled?.()).toBe(false);
    });

    it('is available on child loggers', () => {
      const parent = createLogger({ level: 'error' });
      expect(parent.child({ reqId: 'x' }).isWarnEnabled?.()).toBe(false);
    });
  });

  describe('error cause chain redaction + sanitisation', () => {
    it('renders Error.cause recursively into the serialised output', () => {
      const lines: string[] = [];
      const logger = createLogger({
        json: true,
        output: (line) => lines.push(line),
        redact: false,
      });
      const root = new Error('root cause');
      const mid = new Error('mid layer', { cause: root });
      const top = new Error('top error', { cause: mid });
      logger.error('something failed', { err: top });
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.err.name).toBe('Error');
      expect(parsed.err.message).toBe('top error');
      expect(parsed.err.cause).toBeDefined();
      expect(parsed.err.cause.message).toBe('mid layer');
      expect(parsed.err.cause.cause).toBeDefined();
      expect(parsed.err.cause.cause.message).toBe('root cause');
    });

    it('applies stack sanitisation to every layer of the cause chain', () => {
      const fakeCwd = '/tmp/harness-wave13';
      const root = new Error('root');
      root.stack = `Error: root\n    at fn (${fakeCwd}/pkg/a.ts:1:1)`;
      const top = new Error('top', { cause: root });
      top.stack = `Error: top\n    at fn (${fakeCwd}/pkg/b.ts:2:2)`;

      const lines: string[] = [];
      const logger = createLogger({
        json: true,
        output: (line) => lines.push(line),
        redact: false,
        stackSanitizer: { cwd: fakeCwd },
      });
      logger.error('failed', { err: top });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.err.stack).not.toContain(fakeCwd);
      expect(parsed.err.cause.stack).not.toContain(fakeCwd);
    });

    it('guards against cyclic cause chains', () => {
      const a = new Error('a');
      const b = new Error('b');
      (a as { cause?: unknown }).cause = b;
      (b as { cause?: unknown }).cause = a; // cycle
      const lines: string[] = [];
      const logger = createLogger({
        json: true,
        output: (line) => lines.push(line),
        redact: false,
      });
      expect(() => logger.error('cycle', { err: a })).not.toThrow();
      const parsed = JSON.parse(lines[0]);
      expect(parsed.err.cause).toBeDefined();
      // Somewhere in the nested chain we must reach the cycle marker.
      const asJson = JSON.stringify(parsed);
      expect(asJson).toContain('[Circular]');
    });

    it('caps cause chain depth to avoid pathological payloads', () => {
      let current = new Error('leaf');
      for (let i = 0; i < 20; i++) {
        current = new Error(`layer-${i}`, { cause: current });
      }
      const lines: string[] = [];
      const logger = createLogger({
        json: true,
        output: (line) => lines.push(line),
        redact: false,
      });
      logger.error('deep', { err: current });
      const asJson = lines[0];
      expect(asJson).toContain('[MaxCauseDepthExceeded]');
    });

    it('createSafeReplacer handles Error without cause unchanged', () => {
      const replacer = createSafeReplacer();
      const err = new Error('plain');
      const out = replacer('err', err) as Record<string, unknown>;
      expect(out.name).toBe('Error');
      expect(out.message).toBe('plain');
      expect(out.cause).toBeUndefined();
    });
  });
});
