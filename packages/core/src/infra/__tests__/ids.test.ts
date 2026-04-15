import { describe, it, expect } from 'vitest';
import { secureId, shortSecureId, uuid, prefixedSecureId } from '../ids.js';

describe('ids', () => {
  describe('secureId', () => {
    it('returns a 32-char hex string', () => {
      const id = secureId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });
    it('returns unique values', () => {
      const set = new Set<string>();
      for (let i = 0; i < 1000; i++) set.add(secureId());
      expect(set.size).toBe(1000);
    });
  });

  describe('shortSecureId', () => {
    it('returns a 16-char hex string', () => {
      expect(shortSecureId()).toMatch(/^[0-9a-f]{16}$/);
    });
    it('returns unique values', () => {
      const set = new Set<string>();
      for (let i = 0; i < 1000; i++) set.add(shortSecureId());
      expect(set.size).toBe(1000);
    });
  });

  describe('uuid', () => {
    it('returns an RFC-4122 v4 UUID', () => {
      expect(uuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('prefixedSecureId', () => {
    it('prepends prefix', () => {
      const id = prefixedSecureId('sess');
      expect(id).toMatch(/^sess-[0-9a-f]{32}$/);
    });
    it('allows empty prefix', () => {
      expect(prefixedSecureId('')).toMatch(/^-[0-9a-f]{32}$/);
    });
  });
});
