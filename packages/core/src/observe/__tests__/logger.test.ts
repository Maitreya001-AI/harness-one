import { describe, it, expect, vi } from 'vitest';
import { createLogger } from '../logger.js';
import type { Logger, LogLevel } from '../logger.js';

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

  describe('text format with base meta', () => {
    it('includes base meta in text output', () => {
      const { lines, output } = captureOutput();
      const logger = createLogger({ output });
      const child = logger.child({ component: 'auth' });
      child.info('login');
      expect(lines[0]).toContain('"component":"auth"');
    });
  });
});
