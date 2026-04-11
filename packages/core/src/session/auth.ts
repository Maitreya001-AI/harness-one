/**
 * Authentication context and multi-tenancy helpers.
 *
 * Provides an immutable AuthContext for identifying users, tenants,
 * and their associated roles / permissions.
 *
 * @module
 */

/** Immutable authentication context for a request or session. */
export interface AuthContext {
  readonly userId: string;
  readonly tenantId?: string;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

/**
 * Recursively freeze an object and all nested objects/arrays.
 *
 * Prevents mutation of deeply nested structures. Handles cycles by checking
 * Object.isFrozen() before recursing — already-frozen objects are skipped.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

/**
 * Create a deeply frozen AuthContext from a plain configuration object.
 *
 * All arrays, the metadata object, and any nested objects within metadata are
 * recursively frozen to prevent accidental mutation at any depth.
 *
 * @example
 * ```ts
 * const ctx = createAuthContext({
 *   userId: 'u-1',
 *   tenantId: 't-1',
 *   roles: ['admin'],
 *   permissions: ['read', 'write'],
 * });
 * ```
 */
export function createAuthContext(config: {
  userId: string;
  tenantId?: string;
  roles?: string[];
  permissions?: string[];
  metadata?: Record<string, unknown>;
}): AuthContext {
  return deepFreeze({
    userId: config.userId,
    ...(config.tenantId !== undefined && { tenantId: config.tenantId }),
    ...(config.roles !== undefined && { roles: [...config.roles] }),
    ...(config.permissions !== undefined && { permissions: [...config.permissions] }),
    ...(config.metadata !== undefined && { metadata: { ...config.metadata } }),
  }) as AuthContext;
}

/** Check whether the auth context has a specific role. */
export function hasRole(ctx: AuthContext, role: string): boolean {
  return ctx.roles?.includes(role) ?? false;
}

/** Check whether the auth context has a specific permission. */
export function hasPermission(ctx: AuthContext, permission: string): boolean {
  return ctx.permissions?.includes(permission) ?? false;
}
