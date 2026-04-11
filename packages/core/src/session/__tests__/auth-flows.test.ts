/**
 * Comprehensive tests for session auth flows.
 *
 * Supplements the existing auth.test.ts with additional coverage for:
 * - Full config construction
 * - Auth context immutability at every depth
 * - Multiple concurrent auth context operations
 * - Edge cases: empty strings, special characters, large data
 * - Composite role/permission checks
 * - deepFreeze internals (primitives, null, cycles)
 */
import { describe, it, expect } from 'vitest';
import { createAuthContext, hasRole, hasPermission } from '../auth.js';
import type { AuthContext } from '../auth.js';

// ---------------------------------------------------------------------------
// Full config construction
// ---------------------------------------------------------------------------
describe('createAuthContext — full config', () => {
  it('creates a context with all fields populated', () => {
    const ctx = createAuthContext({
      userId: 'u-full',
      tenantId: 't-acme',
      roles: ['admin', 'editor', 'viewer'],
      permissions: ['read', 'write', 'delete', 'admin'],
      metadata: { org: 'Acme Inc', tier: 'enterprise', settings: { theme: 'dark' } },
    });

    expect(ctx.userId).toBe('u-full');
    expect(ctx.tenantId).toBe('t-acme');
    expect(ctx.roles).toEqual(['admin', 'editor', 'viewer']);
    expect(ctx.permissions).toEqual(['read', 'write', 'delete', 'admin']);
    expect(ctx.metadata).toEqual({ org: 'Acme Inc', tier: 'enterprise', settings: { theme: 'dark' } });
  });

  it('all fields in the returned context are frozen', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      tenantId: 't-1',
      roles: ['admin'],
      permissions: ['write'],
      metadata: { key: 'value' },
    });

    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.roles)).toBe(true);
    expect(Object.isFrozen(ctx.permissions)).toBe(true);
    expect(Object.isFrozen(ctx.metadata)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth context immutability — thorough
// ---------------------------------------------------------------------------
describe('createAuthContext — deep immutability', () => {
  it('mutations to original roles array do not affect the context', () => {
    const roles = ['user', 'editor'];
    const ctx = createAuthContext({ userId: 'u-1', roles });
    roles.push('hacked');
    roles[0] = 'tampered';
    expect(ctx.roles).toEqual(['user', 'editor']);
  });

  it('mutations to original permissions array do not affect the context', () => {
    const permissions = ['read', 'write'];
    const ctx = createAuthContext({ userId: 'u-1', permissions });
    permissions.push('admin');
    permissions[0] = 'tampered';
    expect(ctx.permissions).toEqual(['read', 'write']);
  });

  it('mutations to original metadata object do not affect the context', () => {
    const metadata: Record<string, unknown> = { env: 'prod' };
    const ctx = createAuthContext({ userId: 'u-1', metadata });
    metadata.injected = true;
    metadata.env = 'dev';
    expect(ctx.metadata).toEqual({ env: 'prod' });
  });

  it('deeply nested metadata objects are frozen', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      metadata: {
        level1: {
          level2: {
            level3: { value: 42 },
          },
        },
      },
    });

    const level1 = ctx.metadata!['level1'] as Record<string, unknown>;
    const level2 = level1['level2'] as Record<string, unknown>;
    const level3 = level2['level3'] as Record<string, unknown>;

    expect(Object.isFrozen(level1)).toBe(true);
    expect(Object.isFrozen(level2)).toBe(true);
    expect(Object.isFrozen(level3)).toBe(true);
  });

  it('arrays inside metadata are frozen', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      metadata: { tags: ['a', 'b'], nested: { list: [1, 2, 3] } },
    });

    expect(Object.isFrozen(ctx.metadata!['tags'])).toBe(true);
    const nested = ctx.metadata!['nested'] as Record<string, unknown>;
    expect(Object.isFrozen(nested['list'])).toBe(true);
  });

  it('objects inside arrays inside metadata are frozen', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      metadata: {
        items: [{ id: 1, name: 'item1' }, { id: 2, name: 'item2' }],
      },
    });

    const items = ctx.metadata!['items'] as Array<Record<string, unknown>>;
    expect(Object.isFrozen(items)).toBe(true);
    expect(Object.isFrozen(items[0])).toBe(true);
    expect(Object.isFrozen(items[1])).toBe(true);
  });

  it('attempting to modify a frozen property throws in strict mode or silently fails', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: ['admin'] });

    // In strict-mode environments this throws TypeError; in sloppy mode it is silently ignored
    expect(() => {
      try {
        (ctx as { userId: string }).userId = 'hacked';
      } catch {
        // TypeError in strict mode
      }
    }).not.toThrow();
    expect(ctx.userId).toBe('u-1');
  });

  it('attempting to add a new property to the context fails', () => {
    const ctx = createAuthContext({ userId: 'u-1' });

    expect(() => {
      try {
        (ctx as Record<string, unknown>)['newProp'] = 'bad';
      } catch {
        // TypeError in strict mode
      }
    }).not.toThrow();
    expect((ctx as Record<string, unknown>)['newProp']).toBeUndefined();
  });

  it('attempting to delete a property from the context fails', () => {
    const ctx = createAuthContext({ userId: 'u-1', tenantId: 't-1' });

    expect(() => {
      try {
        delete (ctx as Record<string, unknown>)['tenantId'];
      } catch {
        // TypeError in strict mode
      }
    }).not.toThrow();
    expect(ctx.tenantId).toBe('t-1');
  });
});

// ---------------------------------------------------------------------------
// Multiple concurrent auth context operations
// ---------------------------------------------------------------------------
describe('createAuthContext — concurrent operations', () => {
  it('creating multiple contexts simultaneously produces independent objects', () => {
    const contexts: AuthContext[] = [];
    for (let i = 0; i < 100; i++) {
      contexts.push(
        createAuthContext({
          userId: `u-${i}`,
          tenantId: `t-${i}`,
          roles: [`role-${i}`],
          permissions: [`perm-${i}`],
          metadata: { index: i },
        }),
      );
    }

    // Each context should be independent
    for (let i = 0; i < 100; i++) {
      expect(contexts[i].userId).toBe(`u-${i}`);
      expect(contexts[i].tenantId).toBe(`t-${i}`);
      expect(contexts[i].roles).toEqual([`role-${i}`]);
      expect(contexts[i].permissions).toEqual([`perm-${i}`]);
      expect(contexts[i].metadata).toEqual({ index: i });
    }
  });

  it('async creation of contexts via Promise.all produces correct results', async () => {
    const promises = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve(
        createAuthContext({
          userId: `async-u-${i}`,
          roles: ['user'],
          metadata: { batch: i },
        }),
      ),
    );

    const contexts = await Promise.all(promises);
    expect(contexts).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(contexts[i].userId).toBe(`async-u-${i}`);
      expect(contexts[i].metadata).toEqual({ batch: i });
    }
  });

  it('contexts created from the same input config are deeply equal but not referentially equal', () => {
    const config = {
      userId: 'u-same',
      roles: ['admin'],
      metadata: { key: 'val' },
    };

    const ctx1 = createAuthContext(config);
    const ctx2 = createAuthContext(config);

    expect(ctx1).toEqual(ctx2);
    expect(ctx1).not.toBe(ctx2);
    // Arrays should also be different references
    expect(ctx1.roles).not.toBe(ctx2.roles);
    expect(ctx1.metadata).not.toBe(ctx2.metadata);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('createAuthContext — edge cases', () => {
  it('handles empty string userId', () => {
    const ctx = createAuthContext({ userId: '' });
    expect(ctx.userId).toBe('');
  });

  it('handles very long userId', () => {
    const longId = 'u-' + 'x'.repeat(10000);
    const ctx = createAuthContext({ userId: longId });
    expect(ctx.userId).toBe(longId);
  });

  it('handles userId with special characters', () => {
    const ctx = createAuthContext({ userId: 'user@example.com/tenant:123' });
    expect(ctx.userId).toBe('user@example.com/tenant:123');
  });

  it('handles empty roles array', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: [] });
    expect(ctx.roles).toEqual([]);
    expect(Object.isFrozen(ctx.roles)).toBe(true);
  });

  it('handles empty permissions array', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: [] });
    expect(ctx.permissions).toEqual([]);
    expect(Object.isFrozen(ctx.permissions)).toBe(true);
  });

  it('handles empty metadata object', () => {
    const ctx = createAuthContext({ userId: 'u-1', metadata: {} });
    expect(ctx.metadata).toEqual({});
    expect(Object.isFrozen(ctx.metadata)).toBe(true);
  });

  it('handles metadata with null values', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      metadata: { value: null },
    });
    expect(ctx.metadata!['value']).toBeNull();
  });

  it('handles metadata with numeric values', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      metadata: { count: 0, negative: -1, float: 3.14 },
    });
    expect(ctx.metadata!['count']).toBe(0);
    expect(ctx.metadata!['negative']).toBe(-1);
    expect(ctx.metadata!['float']).toBe(3.14);
  });

  it('handles metadata with boolean values', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      metadata: { active: true, deleted: false },
    });
    expect(ctx.metadata!['active']).toBe(true);
    expect(ctx.metadata!['deleted']).toBe(false);
  });

  it('handles roles with duplicate entries', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: ['admin', 'admin', 'user'] });
    expect(ctx.roles).toEqual(['admin', 'admin', 'user']);
  });

  it('handles permissions with duplicate entries', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: ['read', 'read'] });
    expect(ctx.permissions).toEqual(['read', 'read']);
  });

  it('omits optional fields that are not provided (sparse object)', () => {
    const ctx = createAuthContext({ userId: 'u-1' });
    // The created object should not have keys for undefined optional fields
    expect('tenantId' in ctx).toBe(false);
    expect('roles' in ctx).toBe(false);
    expect('permissions' in ctx).toBe(false);
    expect('metadata' in ctx).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasRole — comprehensive
// ---------------------------------------------------------------------------
describe('hasRole — comprehensive', () => {
  it('returns true for a single matching role', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: ['admin'] });
    expect(hasRole(ctx, 'admin')).toBe(true);
  });

  it('returns true for one of many roles', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: ['viewer', 'editor', 'admin'] });
    expect(hasRole(ctx, 'editor')).toBe(true);
  });

  it('returns false for non-existent role', () => {
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

  it('is case-sensitive', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: ['Admin'] });
    expect(hasRole(ctx, 'admin')).toBe(false);
    expect(hasRole(ctx, 'Admin')).toBe(true);
  });

  it('checks empty string role correctly', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: [''] });
    expect(hasRole(ctx, '')).toBe(true);
    expect(hasRole(ctx, 'admin')).toBe(false);
  });

  it('handles checking multiple roles in sequence', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: ['admin', 'operator'] });
    expect(hasRole(ctx, 'admin')).toBe(true);
    expect(hasRole(ctx, 'operator')).toBe(true);
    expect(hasRole(ctx, 'viewer')).toBe(false);
    expect(hasRole(ctx, 'editor')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasPermission — comprehensive
// ---------------------------------------------------------------------------
describe('hasPermission — comprehensive', () => {
  it('returns true for a single matching permission', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: ['read'] });
    expect(hasPermission(ctx, 'read')).toBe(true);
  });

  it('returns true for one of many permissions', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: ['read', 'write', 'delete'] });
    expect(hasPermission(ctx, 'write')).toBe(true);
  });

  it('returns false for non-existent permission', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: ['read'] });
    expect(hasPermission(ctx, 'write')).toBe(false);
  });

  it('returns false when permissions is undefined', () => {
    const ctx = createAuthContext({ userId: 'u-1' });
    expect(hasPermission(ctx, 'read')).toBe(false);
  });

  it('returns false for empty permissions array', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: [] });
    expect(hasPermission(ctx, 'read')).toBe(false);
  });

  it('is case-sensitive', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: ['Read'] });
    expect(hasPermission(ctx, 'read')).toBe(false);
    expect(hasPermission(ctx, 'Read')).toBe(true);
  });

  it('handles permission strings with special characters', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      permissions: ['resource:read', 'resource:write', 'admin:*'],
    });
    expect(hasPermission(ctx, 'resource:read')).toBe(true);
    expect(hasPermission(ctx, 'admin:*')).toBe(true);
    expect(hasPermission(ctx, 'resource:delete')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Composite role + permission checks
// ---------------------------------------------------------------------------
describe('composite role and permission checks', () => {
  it('context with roles but no permissions works correctly for both checks', () => {
    const ctx = createAuthContext({ userId: 'u-1', roles: ['admin'] });
    expect(hasRole(ctx, 'admin')).toBe(true);
    expect(hasPermission(ctx, 'read')).toBe(false);
  });

  it('context with permissions but no roles works correctly for both checks', () => {
    const ctx = createAuthContext({ userId: 'u-1', permissions: ['read', 'write'] });
    expect(hasRole(ctx, 'admin')).toBe(false);
    expect(hasPermission(ctx, 'read')).toBe(true);
  });

  it('context with both roles and permissions checks each independently', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      roles: ['editor'],
      permissions: ['write'],
    });
    expect(hasRole(ctx, 'editor')).toBe(true);
    expect(hasRole(ctx, 'admin')).toBe(false);
    expect(hasPermission(ctx, 'write')).toBe(true);
    expect(hasPermission(ctx, 'delete')).toBe(false);
  });

  it('simulates an authorization check combining role and permission', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      roles: ['admin'],
      permissions: ['read', 'write', 'delete'],
    });

    const canDeleteAsAdmin = hasRole(ctx, 'admin') && hasPermission(ctx, 'delete');
    expect(canDeleteAsAdmin).toBe(true);

    const canDeleteAsViewer = hasRole(ctx, 'viewer') && hasPermission(ctx, 'delete');
    expect(canDeleteAsViewer).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AuthContext interface compliance
// ---------------------------------------------------------------------------
describe('AuthContext interface compliance', () => {
  it('returned object conforms to AuthContext type shape', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      tenantId: 't-1',
      roles: ['admin'],
      permissions: ['read'],
      metadata: { key: 'val' },
    });

    // TypeScript compile-time check — runtime shape verification
    const shape: AuthContext = ctx;
    expect(shape.userId).toBe('u-1');
    expect(shape.tenantId).toBe('t-1');
    expect(shape.roles).toBeDefined();
    expect(shape.permissions).toBeDefined();
    expect(shape.metadata).toBeDefined();
  });

  it('minimal AuthContext has only userId', () => {
    const ctx: AuthContext = createAuthContext({ userId: 'u-minimal' });
    expect(ctx.userId).toBe('u-minimal');
    expect(ctx.tenantId).toBeUndefined();
    expect(ctx.roles).toBeUndefined();
    expect(ctx.permissions).toBeUndefined();
    expect(ctx.metadata).toBeUndefined();
  });

  it('readonly arrays match the readonly modifier in the interface', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      roles: ['admin'],
      permissions: ['read'],
    });

    // The readonly keyword prevents push/pop at compile time.
    // At runtime, Object.freeze enforces it.
    expect(Object.isFrozen(ctx.roles)).toBe(true);
    expect(Object.isFrozen(ctx.permissions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deepFreeze edge cases (tested indirectly)
// ---------------------------------------------------------------------------
describe('deepFreeze behavior — edge cases', () => {
  it('handles metadata with Date-like objects (frozen as regular objects)', () => {
    const dateObj = { toISOString: () => '2025-01-01T00:00:00Z', getTime: () => 0 };
    const ctx = createAuthContext({
      userId: 'u-1',
      metadata: { created: dateObj },
    });
    expect(Object.isFrozen(ctx.metadata!['created'])).toBe(true);
  });

  it('handles empty nested structures', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      metadata: {
        emptyObj: {},
        emptyArr: [],
        nested: { alsoEmpty: {} },
      },
    });

    expect(Object.isFrozen(ctx.metadata!['emptyObj'])).toBe(true);
    expect(Object.isFrozen(ctx.metadata!['emptyArr'])).toBe(true);
    const nested = ctx.metadata!['nested'] as Record<string, unknown>;
    expect(Object.isFrozen(nested['alsoEmpty'])).toBe(true);
  });

  it('handles metadata with string values that look like code', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      metadata: {
        script: '<script>alert("xss")</script>',
        sql: "'; DROP TABLE users; --",
      },
    });
    expect(ctx.metadata!['script']).toBe('<script>alert("xss")</script>');
    expect(ctx.metadata!['sql']).toBe("'; DROP TABLE users; --");
    expect(Object.isFrozen(ctx.metadata)).toBe(true);
  });

  it('handles metadata with undefined values', () => {
    const ctx = createAuthContext({
      userId: 'u-1',
      metadata: { defined: 'yes', notDefined: undefined },
    });
    expect(ctx.metadata!['defined']).toBe('yes');
    expect(ctx.metadata!['notDefined']).toBeUndefined();
  });

  it('handles large metadata objects without issues', () => {
    const bigMetadata: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      bigMetadata[`key-${i}`] = { index: i, data: `value-${i}` };
    }

    const ctx = createAuthContext({ userId: 'u-1', metadata: bigMetadata });
    expect(Object.isFrozen(ctx.metadata)).toBe(true);
    expect(Object.isFrozen(ctx.metadata!['key-0'])).toBe(true);
    expect(Object.isFrozen(ctx.metadata!['key-999'])).toBe(true);
  });
});
