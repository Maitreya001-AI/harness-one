/**
 * createLogger redact-by-default behavior.
 *
 * Semantics:
 *   - `redact: undefined` (omitted) → default pattern redaction ENABLED.
 *   - `redact: false`               → explicitly OFF (escape hatch).
 *   - `redact: { ... }`             → unchanged (explicit custom config).
 *
 * This file covers only the defaulting logic. Existing behavioral coverage
 * (extraKeys, text mode redaction, nested redaction, prototype pollution,
 * child logger propagation) lives in `logger.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { createLogger } from '../logger.js';

describe('createLogger redact default', () => {
  function captureOutput() {
    const lines: string[] = [];
    const output = (line: string) => lines.push(line);
    return { lines, output };
  }

  describe('default (no redact option) → redaction ON', () => {
    it('redacts api_key by default when no redact option is passed', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      logger.info('req', { api_key: 'sk-abc', user: 'alice' });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.api_key).toBe('[REDACTED]');
      // The raw secret must NOT appear anywhere in the serialized line.
      expect(lines[0]).not.toContain('sk-abc');
      // Non-secret keys still flow through.
      expect(parsed.user).toBe('alice');
    });

    it('redacts authorization/password/token/cookie by default', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      logger.info('multi', {
        authorization: 'Bearer xyz',
        password: 'pw',
        token: 'tok',
        cookie: 'session=zzz',
        safe: 'ok',
      });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.authorization).toBe('[REDACTED]');
      expect(parsed.password).toBe('[REDACTED]');
      expect(parsed.token).toBe('[REDACTED]');
      expect(parsed.cookie).toBe('[REDACTED]');
      expect(parsed.safe).toBe('ok');
    });

    it('redacts nested secret keys by default (deep walk enabled)', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      logger.info('nested', { headers: { authorization: 'Bearer top-secret' } });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.headers.authorization).toBe('[REDACTED]');
      expect(lines[0]).not.toContain('top-secret');
    });

    it('createLogger() with absolutely no args still redacts (covers factory-default path)', () => {
      // No config object at all — the defaulting logic must still activate
      // the default redactor rather than leaving `redactor` undefined.
      const captured: string[] = [];
       
      const origLog = (console as any).log;
       
      (console as any).log = (line: string) => captured.push(line);
      try {
        const logger = createLogger();
        logger.info('default', { api_key: 'sk-xyz' });
      } finally {
         
        (console as any).log = origLog;
      }
      expect(captured).toHaveLength(1);
      expect(captured[0]).not.toContain('sk-xyz');
      expect(captured[0]).toContain('[REDACTED]');
    });
  });

  describe('redact: false → redaction OFF (escape hatch)', () => {
    it('passes api_key through unchanged when redact is explicitly false', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output, redact: false });
      logger.info('req', { api_key: 'sk-abc' });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.api_key).toBe('sk-abc');
      expect(lines[0]).toContain('sk-abc');
    });

    it('does not drop prototype-polluting keys when redact is false (no redactor at all)', () => {
      // When the user fully opts out, we skip sanitizeAttributes entirely,
      // meaning pollution protection is also off. This is an intentional
      // all-or-nothing semantics for the `false` escape hatch.
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output, redact: false });
      logger.info('raw', { password: 'plain' });
      expect(lines[0]).toContain('plain');
    });
  });

  describe('explicit redact config preserved', () => {
    it('redact: { useDefaultPattern: false, extraKeys: ["x"] } only redacts x', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({
        json: true,
        output,
        redact: { useDefaultPattern: false, extraKeys: ['x'] },
      });
      logger.info('custom', { x: 'hidden', api_key: 'visible-by-config', other: 'ok' });
      const parsed = JSON.parse(lines[0]);
      // Custom key is redacted.
      expect(parsed.x).toBe('[REDACTED]');
      // Default pattern is OFF by user's explicit choice → api_key passes through.
      expect(parsed.api_key).toBe('visible-by-config');
      expect(parsed.other).toBe('ok');
    });

    it('redact: {} (empty object) still activates default pattern (backward-compat with existing callers)', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output, redact: {} });
      logger.info('empty-cfg', { api_key: 'sk-should-hide' });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.api_key).toBe('[REDACTED]');
    });

    it('redact: { extraKeys: ["ssn"] } redacts ssn AND default-pattern keys', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({
        json: true,
        output,
        redact: { extraKeys: ['ssn'] },
      });
      logger.info('mix', { ssn: '123', api_key: 'sk', safe: 'ok' });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.ssn).toBe('[REDACTED]');
      expect(parsed.api_key).toBe('[REDACTED]');
      expect(parsed.safe).toBe('ok');
    });
  });

  describe('type-level: redact accepts false', () => {
    it('compiles with redact: false (negative type-assertion via runtime usage)', () => {
      // This test exists primarily so a tsc regression (removing `false` from
      // the union) surfaces as a compile error on this file. The body is a
      // trivial runtime check.
      const { output } = captureOutput();
      const logger = createLogger({ output, redact: false });
      expect(typeof logger.info).toBe('function');
    });
  });
});
