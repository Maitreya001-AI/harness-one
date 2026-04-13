import { describe, it, expect, vi } from 'vitest';
import { createLogger, createSafeReplacer } from '../logger.js';


describe('createLogger', () => {
  function captureOutput() {
    const lines: string[] = [];
    const output = (line: string) => lines.push(line);
    return { lines, output };
  }

  describe('log levels', () => {
    it('defaults to info level', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ output });
      logger.debug('should not appear');
      logger.info('should appear');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('should appear');
    });

    it('respects debug level', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ level: 'debug', output });
      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');
      expect(lines).toHaveLength(4);
    });

    it('respects warn level', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ level: 'warn', output });
      logger.debug('no');
      logger.info('no');
      logger.warn('yes');
      logger.error('yes');
      expect(lines).toHaveLength(2);
    });

    it('respects error level', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ level: 'error', output });
      logger.debug('no');
      logger.info('no');
      logger.warn('no');
      logger.error('yes');
      expect(lines).toHaveLength(1);
    });
  });

  describe('text format (default)', () => {
    it('includes timestamp, level, and message', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ output });
      logger.info('server started');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
      expect(lines[0]).toContain('INFO');
      expect(lines[0]).toContain('server started');
    });

    it('appends meta as JSON when present', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ output });
      logger.info('request', { method: 'GET', path: '/' });
      expect(lines[0]).toContain('"method":"GET"');
      expect(lines[0]).toContain('"path":"/"');
    });

    it('does not append meta when no metadata keys exist', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ output });
      logger.info('clean message');
      // Should not have trailing JSON object
      expect(lines[0]).toMatch(/clean message$/);
    });

    it('includes correct level prefix for each method', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ level: 'debug', output });
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      expect(lines[0]).toContain('DEBUG');
      expect(lines[1]).toContain('INFO');
      expect(lines[2]).toContain('WARN');
      expect(lines[3]).toContain('ERROR');
    });
  });

  describe('JSON format', () => {
    it('outputs valid JSON lines', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      logger.info('hello');
      const parsed = JSON.parse(lines[0]);
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('hello');
      expect(parsed.timestamp).toBeDefined();
    });

    it('includes meta fields in JSON output', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      logger.warn('slow query', { durationMs: 500, query: 'SELECT *' });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.level).toBe('warn');
      expect(parsed.durationMs).toBe(500);
      expect(parsed.query).toBe('SELECT *');
    });

    it('respects log level filtering in JSON mode', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, level: 'error', output });
      logger.info('no');
      logger.error('yes');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).level).toBe('error');
    });
  });

  describe('child logger', () => {
    it('inherits base metadata', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      const child = logger.child({ service: 'api' });
      child.info('request');
      const parsed = JSON.parse(lines[0]);
      expect(parsed.service).toBe('api');
      expect(parsed.message).toBe('request');
    });

    it('merges call-site meta with base meta', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      const child = logger.child({ service: 'api' });
      child.info('request', { requestId: '123' });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.service).toBe('api');
      expect(parsed.requestId).toBe('123');
    });

    it('call-site meta overrides base meta', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      const child = logger.child({ env: 'dev' });
      child.info('test', { env: 'prod' });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.env).toBe('prod');
    });

    it('supports nested child loggers', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      const child1 = logger.child({ service: 'api' });
      const child2 = child1.child({ requestId: 'abc' });
      child2.info('handling');
      const parsed = JSON.parse(lines[0]);
      expect(parsed.service).toBe('api');
      expect(parsed.requestId).toBe('abc');
    });

    it('does not affect parent logger output', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      const child = logger.child({ extra: true });
      logger.info('parent');
      child.info('child');
      expect(JSON.parse(lines[0]).extra).toBeUndefined();
      expect(JSON.parse(lines[1]).extra).toBe(true);
    });

    it('inherits level filtering from parent', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ level: 'warn', output });
      const child = logger.child({ component: 'db' });
      child.debug('no');
      child.info('no');
      child.warn('yes');
      expect(lines).toHaveLength(1);
    });
  });

  describe('defaults', () => {
    it('uses console.log as default output', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const logger = createLogger();
        logger.info('test');
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('works with no config', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const logger = createLogger();
        logger.info('hello');
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls[0][0]).toContain('hello');
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Fix 9: Error serialization via safe replacer
  describe('error serialization', () => {
    it('serializes Error objects in meta to name/message/stack', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      const err = new Error('test failure');
      logger.error('something failed', { error: err });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.error).toBeDefined();
      expect(parsed.error.name).toBe('Error');
      expect(parsed.error.message).toBe('test failure');
      expect(parsed.error.stack).toBeDefined();
    });

    it('serializes Date objects in meta to ISO string', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      const date = new Date('2025-01-01T00:00:00Z');
      logger.info('with date', { createdAt: date });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.createdAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('handles circular references without throwing', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj; // circular
      logger.info('circular', { data: obj });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.data.a).toBe(1);
      expect(parsed.data.self).toBe('[Circular]');
    });

    it('handles circular references in text format', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ output });
      const obj: Record<string, unknown> = { x: 1 };
      obj.ref = obj;
      logger.info('circular text', { data: obj });
      expect(lines[0]).toContain('[Circular]');
    });
  });

  // Fix 9: createSafeReplacer standalone tests
  describe('createSafeReplacer', () => {
    it('serializes Error to object with name/message/stack', () => {
      const replacer = createSafeReplacer();
      const err = new TypeError('bad input');
      const result = replacer('err', err) as Record<string, unknown>;
      expect(result.name).toBe('TypeError');
      expect(result.message).toBe('bad input');
      expect(result.stack).toBeDefined();
    });

    it('serializes Date to ISO string', () => {
      const replacer = createSafeReplacer();
      const date = new Date('2025-06-15T12:00:00Z');
      expect(replacer('d', date)).toBe('2025-06-15T12:00:00.000Z');
    });

    it('detects circular references', () => {
      const replacer = createSafeReplacer();
      const obj = { a: 1 };
      // First pass: obj gets registered
      replacer('', obj);
      // Second pass: same object is circular
      expect(replacer('ref', obj)).toBe('[Circular]');
    });

    it('passes through primitives', () => {
      const replacer = createSafeReplacer();
      expect(replacer('k', 42)).toBe(42);
      expect(replacer('k', 'hello')).toBe('hello');
      expect(replacer('k', true)).toBe(true);
      expect(replacer('k', null)).toBe(null);
    });
  });

  // Fix 10: Performance - defer timestamp (Date.now() stored, formatted at output)
  describe('deferred timestamp formatting', () => {
    it('output still contains ISO timestamp', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ output });
      logger.info('test');
      // The output should still contain a properly formatted ISO timestamp
      expect(lines[0]).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('JSON output contains ISO timestamp', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      logger.info('test');
      const parsed = JSON.parse(lines[0]);
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('text format with base meta', () => {
    it('includes base meta in text output', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ output });
      const child = logger.child({ component: 'auth' });
      child.info('login');
      expect(lines[0]).toContain('"component":"auth"');
    });
  });

  // SEC-001: Secret redaction
  describe('secret redaction (SEC-001)', () => {
    it('redacts api_key keys in meta when redact config is provided', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output, redact: {} });
      logger.info('request', { api_key: 'sk-secret-123', user: 'alice' });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.api_key).toBe('[REDACTED]');
      expect(parsed.user).toBe('alice');
    });

    it('redacts authorization, password, token, cookie by default', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output, redact: {} });
      logger.info('multi', {
        authorization: 'Bearer abc',
        password: 'pw',
        token: 'tok',
        cookie: 'session=xyz',
        safe: 'ok',
      });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.authorization).toBe('[REDACTED]');
      expect(parsed.password).toBe('[REDACTED]');
      expect(parsed.token).toBe('[REDACTED]');
      expect(parsed.cookie).toBe('[REDACTED]');
      expect(parsed.safe).toBe('ok');
    });

    it('redacts nested secret keys recursively', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output, redact: {} });
      logger.info('nested', { headers: { authorization: 'Bearer secret' } });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.headers.authorization).toBe('[REDACTED]');
    });

    it('supports extraKeys for additional custom redaction', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({
        json: true,
        output,
        redact: { extraKeys: ['ssn'] },
      });
      logger.info('custom', { ssn: '123-45-6789', ok: 'fine' });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.ssn).toBe('[REDACTED]');
      expect(parsed.ok).toBe('fine');
    });

    it('does not redact when redact config is absent', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      logger.info('no-redact', { api_key: 'visible' });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.api_key).toBe('visible');
    });

    it('redacts in text mode as well', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ output, redact: {} });
      logger.info('msg', { api_key: 'sk-secret' });
      expect(lines[0]).not.toContain('sk-secret');
      expect(lines[0]).toContain('[REDACTED]');
    });

    it('drops prototype-polluting keys', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output, redact: {} });
      logger.info('polluting', {
        __proto__: { attack: true },
        constructor: 'c',
        prototype: 'p',
        safe: 'ok',
      });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.__proto__.attack).not.toBe(true); // polluting key dropped
      expect(parsed.constructor).not.toBe('c');
      expect(parsed.prototype).not.toBe('p');
      expect(parsed.safe).toBe('ok');
    });

    it('redacts keys added via child logger meta', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output, redact: {} });
      const child = logger.child({ password: 'hidden', service: 'api' });
      child.info('req');
      const parsed = JSON.parse(lines[0]);
      expect(parsed.password).toBe('[REDACTED]');
      expect(parsed.service).toBe('api');
    });
  });

  // OBS-001: Correlation ID support
  describe('correlationId (OBS-001)', () => {
    it('injects correlationId into every log record', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output, correlationId: 'req-abc' });
      logger.info('hello');
      const parsed = JSON.parse(lines[0]);
      expect(parsed.correlationId).toBe('req-abc');
    });

    it('correlationId appears in JSON and text modes', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ output, correlationId: 'req-xyz' });
      logger.info('hello');
      expect(lines[0]).toContain('"correlationId":"req-xyz"');
    });

    it('call-site meta can override correlationId if needed', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output, correlationId: 'req-base' });
      logger.info('override', { correlationId: 'req-overridden' });
      const parsed = JSON.parse(lines[0]);
      expect(parsed.correlationId).toBe('req-overridden');
    });

    it('child logger inherits correlationId from parent', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output, correlationId: 'req-root' });
      const child = logger.child({ service: 'api' });
      child.info('hello');
      const parsed = JSON.parse(lines[0]);
      expect(parsed.correlationId).toBe('req-root');
      expect(parsed.service).toBe('api');
    });

    it('does not emit correlationId field when not configured', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ json: true, output });
      logger.info('no-cid');
      const parsed = JSON.parse(lines[0]);
      expect(parsed.correlationId).toBeUndefined();
    });
  });
});
