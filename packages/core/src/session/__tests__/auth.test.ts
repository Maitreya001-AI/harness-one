import { describe, it, expect } from 'vitest';
import { createAuthContext, hasRole, hasPermission } from '../auth.js';

describe('createAuthContext', () => {
  it('creates an auth context with userId', () => {
    const ctx = createAuthContext({ userId: 'u-1' });
    expect(ctx.userId).toBe('u-1');
  });

  it('includes optional tenantId', () => {
    const ctx = createAuthContext({ userId: 'u-1', tenantId: 't-1' });
    expect(ctx.tenantId).toBe('t-1');
  });

  it('includes optional roles', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: ['admin', 'editor'] });
    expect(ctx.roles).toEqual(['admin', 'editor']);
  });

  it('includes optional permissions', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: ['read', 'write'] });
    expect(ctx.permissions).toEqual(['read', 'write']);
  });

  it('includes optional metadata', () => {
    const ctx = createAuthContext({ userId: 'u-1', metadata: { org: 'acme' } });
    expect(ctx.metadata).toEqual({ org: 'acme' });
  });

  it('returns undefined for unset optional fields', () => {
    const ctx = createAuthContext({ userId: 'u-1' });
    expect(ctx.tenantId).toBeUndefined();
    expect(ctx.roles).toBeUndefined();
    expect(ctx.permissions).toBeUndefined();
    expect(ctx.metadata).toBeUndefined();
  });

  describe('immutability', () => {
    it('freezes the context object', () => {
      const ctx = createAuthContext({ userId: 'u-1' });
      expect(Object.isFrozen(ctx)).toBe(true);
    });

    it('freezes the roles array', () => {
      const ctx = createAuthContext({ userId: 'u-1', roles: ['admin'] });
      expect(Object.isFrozen(ctx.roles)).toBe(true);
    });

    it('freezes the permissions array', () => {
      const ctx = createAuthContext({ userId: 'u-1', permissions: ['read'] });
      expect(Object.isFrozen(ctx.permissions)).toBe(true);
    });

    it('freezes the metadata object', () => {
      const ctx = createAuthContext({ userId: 'u-1', metadata: { key: 'val' } });
      expect(Object.isFrozen(ctx.metadata)).toBe(true);
    });

    it('creates defensive copies of input arrays', () => {
      const roles = ['admin'];
      const ctx = createAuthContext({ userId: 'u-1', roles });
      roles.push('hacked');
      expect(ctx.roles).toEqual(['admin']);
    });

    it('creates defensive copies of metadata', () => {
      const metadata = { key: 'val' };
      const ctx = createAuthContext({ userId: 'u-1', metadata });
      (metadata as Record<string, unknown>).injected = true;
      expect(ctx.metadata).toEqual({ key: 'val' });
    });
  });
});

// Issue 4 fix: Deep freeze — nested objects within metadata are now also frozen
describe('deep freeze behavior (Issue 4 fix)', () => {
  it('top-level metadata is frozen', () => {
    const ctx = createAuthContext({ userId: 'u-1', metadata: { nested: { deep: true } } });
    expect(Object.isFrozen(ctx.metadata)).toBe(true);
  });

  it('nested objects within metadata are deeply frozen (Issue 4 fix)', () => {
    const nested = { deep: true };
    const ctx = createAuthContext({ userId: 'u-1', metadata: { nested } });
    // Deep freeze means nested object IS frozen
    expect(Object.isFrozen(ctx.metadata!['nested'])).toBe(true);
  });

  it('deeply nested objects at multiple levels are all frozen', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      metadata: {
        level1: {
          level2: {
            value: 42,
          },
        },
      },
    });
    expect(Object.isFrozen(ctx.metadata)).toBe(true);
    expect(Object.isFrozen(ctx.metadata!['level1'])).toBe(true);
    expect(Object.isFrozen((ctx.metadata!['level1'] as Record<string, unknown>)['level2'])).toBe(true);
  });

  it('mutation of nested metadata object is silently prevented in strict mode', () => {
    const ctx = createAuthContext({ userId: 'u-1', metadata: { nested: { deep: true } } });
    const nested = ctx.metadata!['nested'] as Record<string, unknown>;
    // In non-strict mode, assignment to frozen prop is silently ignored
    expect(() => {
      try {
        nested['deep'] = false;
      } catch {
        // TypeError in strict mode — also acceptable
      }
    }).not.toThrow();
    // The value should remain unchanged
    expect(nested['deep']).toBe(true);
  });

  it('arrays in metadata are deeply frozen', () => {
    const ctx = createAuthContext({ userId: 'u-1', metadata: { items: [1, 2, 3] } });
    expect(Object.isFrozen(ctx.metadata!['items'])).toBe(true);
  });
});

describe('hasRole', () => {
  it('returns true when the role exists', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: ['admin', 'editor'] });
    expect(hasRole(ctx, 'admin')).toBe(true);
    expect(hasRole(ctx, 'editor')).toBe(true);
  });

  it('returns false when the role does not exist', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: ['viewer'] });
    expect(hasRole(ctx, 'admin')).toBe(false);
  });

  it('returns false when roles is undefined', () => {
    const ctx = createAuthContext({ userId: 'u-1' });
    expect(hasRole(ctx, 'admin')).toBe(false);
  });

  it('returns false for empty roles array', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: [] });
    expect(hasRole(ctx, 'admin')).toBe(false);
  });
});

describe('hasPermission', () => {
  it('returns true when the permission exists', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: ['read', 'write'] });
    expect(hasPermission(ctx, 'read')).toBe(true);
    expect(hasPermission(ctx, 'write')).toBe(true);
  });

  it('returns false when the permission does not exist', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: ['read'] });
    expect(hasPermission(ctx, 'delete')).toBe(false);
  });

  it('returns false when permissions is undefined', () => {
    const ctx = createAuthContext({ userId: 'u-1' });
    expect(hasPermission(ctx, 'read')).toBe(false);
  });

  it('returns false for empty permissions array', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: [] });
    expect(hasPermission(ctx, 'read')).toBe(false);
  });
});
