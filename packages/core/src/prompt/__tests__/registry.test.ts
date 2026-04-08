import { describe, it, expect } from 'vitest';
import { createPromptRegistry } from '../registry.js';
import { HarnessError } from '../../core/errors.js';

describe('createPromptRegistry', () => {
  it('registers and retrieves a template', () => {
    const reg = createPromptRegistry();
    reg.register({ id: 'greet', version: '1.0', content: 'Hello {{name}}', variables: ['name'] });
    const t = reg.get('greet');
    expect(t).toBeDefined();
    expect(t!.id).toBe('greet');
  });

  it('returns undefined for unknown template', () => {
    const reg = createPromptRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('supports multiple versions', () => {
    const reg = createPromptRegistry();
    reg.register({ id: 'greet', version: '1.0', content: 'Hello v1', variables: [] });
    reg.register({ id: 'greet', version: '2.0', content: 'Hello v2', variables: [] });
    expect(reg.get('greet', '1.0')!.content).toBe('Hello v1');
    expect(reg.get('greet', '2.0')!.content).toBe('Hello v2');
  });

  it('returns latest version by default', () => {
    const reg = createPromptRegistry();
    reg.register({ id: 'greet', version: '1.0', content: 'Hello v1', variables: [] });
    reg.register({ id: 'greet', version: '2.0', content: 'Hello v2', variables: [] });
    expect(reg.get('greet')!.content).toBe('Hello v2');
  });

  it('freezes templates on register', () => {
    const reg = createPromptRegistry();
    const template = { id: 'a', version: '1.0', content: 'test', variables: [] };
    reg.register(template);
    const stored = reg.get('a')!;
    expect(Object.isFrozen(stored)).toBe(true);
  });

  describe('resolve', () => {
    it('replaces variables in content', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'greet', version: '1.0', content: 'Hello {{name}}, age {{age}}', variables: ['name', 'age'] });
      const result = reg.resolve('greet', { name: 'Alice', age: '30' });
      expect(result).toBe('Hello Alice, age 30');
    });

    it('resolves a specific version', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'g', version: '1.0', content: 'V1 {{x}}', variables: ['x'] });
      reg.register({ id: 'g', version: '2.0', content: 'V2 {{x}}', variables: ['x'] });
      expect(reg.resolve('g', { x: 'val' }, '1.0')).toBe('V1 val');
    });

    it('throws HarnessError for missing template', () => {
      const reg = createPromptRegistry();
      expect(() => reg.resolve('nope', {})).toThrow(HarnessError);
      try {
        reg.resolve('nope', {});
      } catch (e) {
        expect((e as HarnessError).code).toBe('TEMPLATE_NOT_FOUND');
      }
    });

    it('throws HarnessError for missing variable', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'g', version: '1.0', content: 'Hello {{name}}', variables: ['name'] });
      expect(() => reg.resolve('g', {})).toThrow(HarnessError);
      try {
        reg.resolve('g', {});
      } catch (e) {
        expect((e as HarnessError).code).toBe('MISSING_VARIABLE');
      }
    });
  });

  describe('list', () => {
    it('lists all templates across versions', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'a', version: '1.0', content: 'A', variables: [] });
      reg.register({ id: 'b', version: '1.0', content: 'B', variables: [] });
      expect(reg.list()).toHaveLength(2);
    });
  });

  describe('has', () => {
    it('returns true for registered templates', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'a', version: '1.0', content: 'A', variables: [] });
      expect(reg.has('a')).toBe(true);
      expect(reg.has('b')).toBe(false);
    });
  });

  describe('TTL management', () => {
    it('returns a template with expiresAt in the future normally', () => {
      const reg = createPromptRegistry();
      const futureMs = Date.now() + 60_000;
      reg.register({ id: 'fresh', version: '1.0', content: 'I am fresh', variables: [], expiresAt: futureMs });
      expect(reg.get('fresh')).toBeDefined();
      expect(reg.get('fresh')!.content).toBe('I am fresh');
      expect(reg.isExpired('fresh')).toBe(false);
    });

    it('treats a template with expiresAt in the past as expired', () => {
      const reg = createPromptRegistry();
      const pastMs = Date.now() - 60_000;
      reg.register({ id: 'stale', version: '1.0', content: 'I am stale', variables: [], expiresAt: pastMs });
      expect(reg.isExpired('stale')).toBe(true);
      // get() still returns the template — caller uses isExpired() to decide
      expect(reg.get('stale')).toBeDefined();
    });

    it('isExpired returns false for templates without expiresAt', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'forever', version: '1.0', content: 'No TTL', variables: [] });
      expect(reg.isExpired('forever')).toBe(false);
    });

    it('isExpired returns false for unknown template ids', () => {
      const reg = createPromptRegistry();
      expect(reg.isExpired('nonexistent')).toBe(false);
    });

    it('isExpired checks a specific version', () => {
      const reg = createPromptRegistry();
      const pastMs = Date.now() - 60_000;
      const futureMs = Date.now() + 60_000;
      reg.register({ id: 'multi', version: '1.0', content: 'old', variables: [], expiresAt: pastMs });
      reg.register({ id: 'multi', version: '2.0', content: 'new', variables: [], expiresAt: futureMs });
      expect(reg.isExpired('multi', '1.0')).toBe(true);
      expect(reg.isExpired('multi', '2.0')).toBe(false);
    });

    it('getExpired() returns only expired templates', () => {
      const reg = createPromptRegistry();
      const pastMs = Date.now() - 60_000;
      const futureMs = Date.now() + 60_000;
      reg.register({ id: 'a', version: '1.0', content: 'A', variables: [], expiresAt: pastMs });
      reg.register({ id: 'b', version: '1.0', content: 'B', variables: [], expiresAt: futureMs });
      reg.register({ id: 'c', version: '1.0', content: 'C', variables: [] }); // no TTL
      const expired = reg.getExpired();
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe('a');
    });

    it('removeExpired() cleans up expired entries and returns count', () => {
      const reg = createPromptRegistry();
      const pastMs = Date.now() - 60_000;
      const futureMs = Date.now() + 60_000;
      reg.register({ id: 'x', version: '1.0', content: 'X', variables: [], expiresAt: pastMs });
      reg.register({ id: 'x', version: '2.0', content: 'X2', variables: [], expiresAt: pastMs });
      reg.register({ id: 'y', version: '1.0', content: 'Y', variables: [], expiresAt: futureMs });
      reg.register({ id: 'z', version: '1.0', content: 'Z', variables: [] });
      const removed = reg.removeExpired();
      expect(removed).toBe(2);
      // expired templates are gone
      expect(reg.get('x', '1.0')).toBeUndefined();
      expect(reg.get('x', '2.0')).toBeUndefined();
      // non-expired templates remain
      expect(reg.get('y')).toBeDefined();
      expect(reg.get('z')).toBeDefined();
      // list should reflect removal
      expect(reg.list()).toHaveLength(2);
    });

    it('removeExpired() returns 0 when nothing is expired', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'a', version: '1.0', content: 'A', variables: [] });
      expect(reg.removeExpired()).toBe(0);
    });

    it('removeExpired() cleans up the id entry when all versions are expired', () => {
      const reg = createPromptRegistry();
      const pastMs = Date.now() - 60_000;
      reg.register({ id: 'gone', version: '1.0', content: 'Gone', variables: [], expiresAt: pastMs });
      reg.removeExpired();
      expect(reg.has('gone')).toBe(false);
    });

    it('template at exact expiry boundary (Date.now() === expiresAt) is NOT expired', () => {
      const reg = createPromptRegistry();
      const now = Date.now();
      reg.register({ id: 'boundary', version: '1.0', content: 'Boundary', variables: [], expiresAt: now });
      // isExpired uses Date.now() > expiresAt, so at exact boundary it should NOT be expired
      // (because the time the check runs may equal expiresAt)
      // We mock Date.now to return exactly the expiresAt value
      const origNow = Date.now;
      Date.now = () => now;
      try {
        expect(reg.isExpired('boundary')).toBe(false);
      } finally {
        Date.now = origNow;
      }
    });

    it('multiple versions: some expired, some not', () => {
      const reg = createPromptRegistry();
      const pastMs = Date.now() - 60_000;
      const futureMs = Date.now() + 60_000;
      reg.register({ id: 'multi', version: '1.0', content: 'old', variables: [], expiresAt: pastMs });
      reg.register({ id: 'multi', version: '2.0', content: 'new', variables: [], expiresAt: futureMs });
      reg.register({ id: 'multi', version: '3.0', content: 'newest', variables: [], expiresAt: pastMs });

      const expired = reg.getExpired();
      const expiredVersions = expired.map(t => t.version);
      expect(expiredVersions).toContain('1.0');
      expect(expiredVersions).toContain('3.0');
      expect(expiredVersions).not.toContain('2.0');

      const removed = reg.removeExpired();
      expect(removed).toBe(2);
      expect(reg.get('multi', '2.0')).toBeDefined();
      expect(reg.get('multi', '1.0')).toBeUndefined();
      expect(reg.get('multi', '3.0')).toBeUndefined();
    });

    it('getLatestVersion returns most recently registered', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'seq', version: '1.0', content: 'First', variables: [] });
      reg.register({ id: 'seq', version: '2.0', content: 'Second', variables: [] });
      reg.register({ id: 'seq', version: '3.0', content: 'Third', variables: [] });
      // get() without version should return the last registered
      const latest = reg.get('seq');
      expect(latest).toBeDefined();
      expect(latest!.version).toBe('3.0');
      expect(latest!.content).toBe('Third');
    });

    it('remove non-existent template — no error', () => {
      const reg = createPromptRegistry();
      // removeExpired on empty registry should not throw
      expect(reg.removeExpired()).toBe(0);
      // Register one non-expired template, removeExpired should still return 0
      reg.register({ id: 'safe', version: '1.0', content: 'Safe', variables: [] });
      expect(reg.removeExpired()).toBe(0);
      expect(reg.has('safe')).toBe(true);
    });
  });
});
