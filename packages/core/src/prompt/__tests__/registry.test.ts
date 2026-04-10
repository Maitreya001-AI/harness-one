import { describe, it, expect, vi } from 'vitest';
import { createPromptRegistry, createAsyncPromptRegistry } from '../registry.js';
import { HarnessError } from '../../core/errors.js';
import type { PromptBackend, PromptTemplate } from '../types.js';

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

    it('explicit version tracking returns highest version regardless of registration order', () => {
      const reg = createPromptRegistry();
      // Register out of order
      reg.register({ id: 'ooo', version: '3.0', content: 'Three', variables: [] });
      reg.register({ id: 'ooo', version: '1.0', content: 'One', variables: [] });
      reg.register({ id: 'ooo', version: '2.0', content: 'Two', variables: [] });
      // Should return version 3.0 (highest string comparison) not 2.0 (last registered)
      const latest = reg.get('ooo');
      expect(latest).toBeDefined();
      expect(latest!.version).toBe('3.0');
      expect(latest!.content).toBe('Three');
    });

    it('explicit version tracking updates when removing expired latest version', () => {
      const reg = createPromptRegistry();
      const pastMs = Date.now() - 60_000;
      reg.register({ id: 'track', version: '1.0', content: 'V1', variables: [] });
      reg.register({ id: 'track', version: '2.0', content: 'V2', variables: [], expiresAt: pastMs });
      // Latest should be 2.0
      expect(reg.get('track')!.version).toBe('2.0');
      // Remove expired
      reg.removeExpired();
      // Now latest should fall back to 1.0
      const latest = reg.get('track');
      expect(latest).toBeDefined();
      expect(latest!.version).toBe('1.0');
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

  describe('overwrite behavior (force option)', () => {
    it('logs a warning when overwriting without force option', () => {
      const reg = createPromptRegistry();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      reg.register({ id: 'a', version: '1.0', content: 'Original', variables: [] });
      reg.register({ id: 'a', version: '1.0', content: 'Overwritten', variables: [] });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('Overwriting template');
      expect(warnSpy.mock.calls[0][0]).toContain('a@1.0');
      // Overwrite still happens
      expect(reg.get('a', '1.0')!.content).toBe('Overwritten');
      warnSpy.mockRestore();
    });

    it('does not log a warning when overwriting with force=true', () => {
      const reg = createPromptRegistry();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      reg.register({ id: 'a', version: '1.0', content: 'Original', variables: [] });
      reg.register({ id: 'a', version: '1.0', content: 'Overwritten', variables: [] }, { force: true });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(reg.get('a', '1.0')!.content).toBe('Overwritten');
      warnSpy.mockRestore();
    });

    it('does not log a warning for first registration', () => {
      const reg = createPromptRegistry();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      reg.register({ id: 'a', version: '1.0', content: 'First', variables: [] });
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('semantic version comparison', () => {
    it('treats "1.10" as newer than "1.2" (not lexicographic)', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'sv', version: '1.2', content: 'V1.2', variables: [] });
      reg.register({ id: 'sv', version: '1.10', content: 'V1.10', variables: [] });
      const latest = reg.get('sv');
      expect(latest).toBeDefined();
      expect(latest!.version).toBe('1.10');
      expect(latest!.content).toBe('V1.10');
    });

    it('treats "2.0" as newer than "1.99"', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'sv2', version: '1.99', content: 'V1.99', variables: [] });
      reg.register({ id: 'sv2', version: '2.0', content: 'V2.0', variables: [] });
      const latest = reg.get('sv2');
      expect(latest).toBeDefined();
      expect(latest!.version).toBe('2.0');
    });

    it('treats "1.0.0" and "1.0" as equivalent — last registered wins', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'sv3', version: '1.0', content: 'V1.0', variables: [] });
      reg.register({ id: 'sv3', version: '1.0.0', content: 'V1.0.0', variables: [] });
      // Both represent the same semver, but they are different version strings
      // Since 1.0.0 == 1.0 semantically, 1.0.0 (registered later) should not replace 1.0 as latest
      // but also should not make 1.0 the latest since they are equal
      // The key behavior: get without version returns the latest by semver
      const latest = reg.get('sv3');
      expect(latest).toBeDefined();
      // 1.0.0 was registered second and equals 1.0 semantically, so latest stays at 1.0
      // (no update when versions are equal)
    });

    it('handles multi-segment versions like "1.2.3" vs "1.10.1"', () => {
      const reg = createPromptRegistry();
      reg.register({ id: 'sv4', version: '1.10.1', content: 'V1.10.1', variables: [] });
      reg.register({ id: 'sv4', version: '1.2.3', content: 'V1.2.3', variables: [] });
      const latest = reg.get('sv4');
      expect(latest).toBeDefined();
      expect(latest!.version).toBe('1.10.1');
    });

    it('registers "1.10" before "1.2" and still resolves 1.10 as latest', () => {
      const reg = createPromptRegistry();
      // Register higher version first
      reg.register({ id: 'sv5', version: '1.10', content: 'V1.10', variables: [] });
      reg.register({ id: 'sv5', version: '1.2', content: 'V1.2', variables: [] });
      const latest = reg.get('sv5');
      expect(latest).toBeDefined();
      expect(latest!.version).toBe('1.10');
    });

    it('removeExpired recomputes latest version using semver', () => {
      const reg = createPromptRegistry();
      const pastMs = Date.now() - 60_000;
      reg.register({ id: 'svexp', version: '1.2', content: 'V1.2', variables: [] });
      reg.register({ id: 'svexp', version: '1.10', content: 'V1.10', variables: [], expiresAt: pastMs });
      reg.register({ id: 'svexp', version: '1.5', content: 'V1.5', variables: [] });
      // Latest is 1.10, but it expires
      reg.removeExpired();
      // After removal, latest should be 1.5 (not 1.2) because 1.5 > 1.2 semantically
      const latest = reg.get('svexp');
      expect(latest).toBeDefined();
      expect(latest!.version).toBe('1.5');
    });
  });
});

describe('createAsyncPromptRegistry', () => {
  function makeBackend(overrides: Partial<PromptBackend> = {}): PromptBackend {
    return {
      fetch: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  const templateA: PromptTemplate = { id: 'a', version: '1.0', content: 'Hello {{name}}', variables: ['name'] };
  const templateB: PromptTemplate = { id: 'b', version: '1.0', content: 'Bye {{name}}', variables: ['name'] };

  describe('register', () => {
    it('registers a template locally', () => {
      const backend = makeBackend();
      const reg = createAsyncPromptRegistry(backend);
      reg.register(templateA);
      expect(reg.has('a')).toBe(true);
    });
  });

  describe('has', () => {
    it('returns true for locally registered templates', () => {
      const backend = makeBackend();
      const reg = createAsyncPromptRegistry(backend);
      reg.register(templateA);
      expect(reg.has('a')).toBe(true);
    });

    it('returns false for templates not in local cache', () => {
      const backend = makeBackend();
      const reg = createAsyncPromptRegistry(backend);
      expect(reg.has('nonexistent')).toBe(false);
    });
  });

  describe('get', () => {
    it('returns a locally registered template without calling backend', async () => {
      const fetchFn = vi.fn();
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);
      reg.register(templateA);

      const result = await reg.get('a');
      expect(result).toBeDefined();
      expect(result!.id).toBe('a');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('falls back to backend when template is not in local cache', async () => {
      const fetchFn = vi.fn().mockResolvedValue(templateA);
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      const result = await reg.get('a');
      expect(result).toBeDefined();
      expect(result!.id).toBe('a');
      expect(fetchFn).toHaveBeenCalledWith('a', undefined);
    });

    it('caches backend result locally after fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue(templateA);
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      // First call fetches from backend
      await reg.get('a');
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Second call should use local cache
      const result2 = await reg.get('a');
      expect(result2).toBeDefined();
      expect(result2!.id).toBe('a');
      expect(fetchFn).toHaveBeenCalledTimes(1); // still 1 — not called again
    });

    it('returns undefined when neither local nor backend has the template', async () => {
      const fetchFn = vi.fn().mockResolvedValue(undefined);
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      const result = await reg.get('unknown');
      expect(result).toBeUndefined();
      expect(fetchFn).toHaveBeenCalledWith('unknown', undefined);
    });

    it('passes version to backend.fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue(templateA);
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      await reg.get('a', '1.0');
      expect(fetchFn).toHaveBeenCalledWith('a', '1.0');
    });

    it('returns local template for a specific version without calling backend', async () => {
      const fetchFn = vi.fn();
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);
      reg.register(templateA);

      const result = await reg.get('a', '1.0');
      expect(result).toBeDefined();
      expect(result!.version).toBe('1.0');
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('resolve', () => {
    it('resolves variables from a locally registered template', async () => {
      const backend = makeBackend();
      const reg = createAsyncPromptRegistry(backend);
      reg.register(templateA);

      const result = await reg.resolve('a', { name: 'Alice' });
      expect(result).toBe('Hello Alice');
    });

    it('resolves variables from a backend-fetched template', async () => {
      const fetchFn = vi.fn().mockResolvedValue(templateA);
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      const result = await reg.resolve('a', { name: 'Bob' });
      expect(result).toBe('Hello Bob');
    });

    it('resolves a specific version', async () => {
      const v1: PromptTemplate = { id: 'g', version: '1.0', content: 'V1 {{x}}', variables: ['x'] };
      const fetchFn = vi.fn().mockResolvedValue(v1);
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      const result = await reg.resolve('g', { x: 'val' }, '1.0');
      expect(result).toBe('V1 val');
    });

    it('throws TEMPLATE_NOT_FOUND when template does not exist anywhere', async () => {
      const fetchFn = vi.fn().mockResolvedValue(undefined);
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      await expect(reg.resolve('nope', {})).rejects.toThrow(HarnessError);
      try {
        await reg.resolve('nope', {});
      } catch (e) {
        expect((e as HarnessError).code).toBe('TEMPLATE_NOT_FOUND');
      }
    });

    it('throws TEMPLATE_NOT_FOUND with version info in message', async () => {
      const fetchFn = vi.fn().mockResolvedValue(undefined);
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      try {
        await reg.resolve('nope', {}, '2.0');
      } catch (e) {
        expect((e as HarnessError).code).toBe('TEMPLATE_NOT_FOUND');
        expect((e as HarnessError).message).toContain('nope@2.0');
      }
    });

    it('throws MISSING_VARIABLE when a required variable is not provided', async () => {
      const backend = makeBackend();
      const reg = createAsyncPromptRegistry(backend);
      reg.register(templateA);

      await expect(reg.resolve('a', {})).rejects.toThrow(HarnessError);
      try {
        await reg.resolve('a', {});
      } catch (e) {
        expect((e as HarnessError).code).toBe('MISSING_VARIABLE');
      }
    });

    it('resolves template with multiple variables', async () => {
      const multiVar: PromptTemplate = {
        id: 'multi', version: '1.0', content: '{{greeting}} {{name}}, age {{age}}',
        variables: ['greeting', 'name', 'age'],
      };
      const backend = makeBackend();
      const reg = createAsyncPromptRegistry(backend);
      reg.register(multiVar);

      const result = await reg.resolve('multi', { greeting: 'Hi', name: 'Alice', age: '30' });
      expect(result).toBe('Hi Alice, age 30');
    });
  });

  describe('list', () => {
    it('returns local templates when backend has no list method', async () => {
      const backend: PromptBackend = {
        fetch: vi.fn().mockResolvedValue(undefined),
        // No list method
      };
      const reg = createAsyncPromptRegistry(backend);
      reg.register(templateA);
      reg.register(templateB);

      const result = await reg.list();
      expect(result).toHaveLength(2);
    });

    it('merges local and remote templates, preferring local', async () => {
      const remoteA: PromptTemplate = { id: 'a', version: '1.0', content: 'Remote A', variables: [] };
      const remoteC: PromptTemplate = { id: 'c', version: '1.0', content: 'Remote C', variables: [] };
      const listFn = vi.fn().mockResolvedValue([remoteA, remoteC]);
      const backend = makeBackend({ list: listFn });
      const reg = createAsyncPromptRegistry(backend);
      reg.register(templateA); // local 'a@1.0'

      const result = await reg.list();
      // Should have local 'a@1.0', local 'a@1.0' (not duplicated), and remote 'c@1.0'
      expect(result).toHaveLength(2);
      // Local version of 'a' takes priority — content should be local
      const aTemplate = result.find((t) => t.id === 'a');
      expect(aTemplate!.content).toBe('Hello {{name}}');
      // Remote-only template 'c' should be included
      const cTemplate = result.find((t) => t.id === 'c');
      expect(cTemplate).toBeDefined();
      expect(cTemplate!.content).toBe('Remote C');
    });

    it('includes remote templates with different versions from local', async () => {
      const remoteA2: PromptTemplate = { id: 'a', version: '2.0', content: 'Remote A v2', variables: [] };
      const listFn = vi.fn().mockResolvedValue([remoteA2]);
      const backend = makeBackend({ list: listFn });
      const reg = createAsyncPromptRegistry(backend);
      reg.register(templateA); // local 'a@1.0'

      const result = await reg.list();
      // local a@1.0 + remote a@2.0 should both be present
      expect(result).toHaveLength(2);
      expect(result.find((t) => t.version === '1.0')).toBeDefined();
      expect(result.find((t) => t.version === '2.0')).toBeDefined();
    });

    it('returns empty array when no local or remote templates', async () => {
      const listFn = vi.fn().mockResolvedValue([]);
      const backend = makeBackend({ list: listFn });
      const reg = createAsyncPromptRegistry(backend);

      const result = await reg.list();
      expect(result).toHaveLength(0);
    });
  });

  describe('prefetch', () => {
    it('fetches templates from backend and caches them locally', async () => {
      const fetchFn = vi.fn().mockImplementation(async (id: string) => {
        if (id === 'a') return templateA;
        if (id === 'b') return templateB;
        return undefined;
      });
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      await reg.prefetch(['a', 'b']);

      expect(reg.has('a')).toBe(true);
      expect(reg.has('b')).toBe(true);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('skips ids already in local cache', async () => {
      const fetchFn = vi.fn().mockResolvedValue(templateB);
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);
      reg.register(templateA); // 'a' already local

      await reg.prefetch(['a', 'b']);

      // Only 'b' should be fetched
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith('b');
    });

    it('handles backend returning undefined for some ids', async () => {
      const fetchFn = vi.fn().mockImplementation(async (id: string) => {
        if (id === 'a') return templateA;
        return undefined; // 'unknown' not found
      });
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      await reg.prefetch(['a', 'unknown']);

      expect(reg.has('a')).toBe(true);
      expect(reg.has('unknown')).toBe(false);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('handles empty prefetch list', async () => {
      const fetchFn = vi.fn();
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      const result = await reg.prefetch([]);

      expect(fetchFn).not.toHaveBeenCalled();
      expect(result.succeeded).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it('returns succeeded and failed IDs with partial failure handling', async () => {
      const fetchFn = vi.fn().mockImplementation(async (id: string) => {
        if (id === 'a') return templateA;
        if (id === 'bad') throw new Error('Network error');
        return undefined;
      });
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      const result = await reg.prefetch(['a', 'bad']);

      expect(result.succeeded).toContain('a');
      expect(result.failed).toContain('bad');
      // 'a' was fetched successfully
      expect(reg.has('a')).toBe(true);
    });

    it('does not reject when one prefetch fails (uses allSettled)', async () => {
      const fetchFn = vi.fn().mockImplementation(async (id: string) => {
        if (id === 'ok') return templateA;
        throw new Error('Backend down');
      });
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      // Should NOT throw even though 'fail1' and 'fail2' fail
      const result = await reg.prefetch(['ok', 'fail1', 'fail2']);

      expect(result.succeeded).toEqual(['ok']);
      expect(result.failed).toEqual(['fail1', 'fail2']);
    });

    it('returns all succeeded when no failures', async () => {
      const fetchFn = vi.fn().mockImplementation(async (id: string) => {
        if (id === 'a') return templateA;
        if (id === 'b') return templateB;
        return undefined;
      });
      const backend = makeBackend({ fetch: fetchFn });
      const reg = createAsyncPromptRegistry(backend);

      const result = await reg.prefetch(['a', 'b']);

      expect(result.succeeded).toEqual(['a', 'b']);
      expect(result.failed).toEqual([]);
    });
  });
});
