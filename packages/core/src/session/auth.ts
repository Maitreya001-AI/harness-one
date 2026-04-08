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
 * Create a frozen AuthContext from a plain configuration object.
 *
 * All arrays and the metadata object are shallow-frozen to prevent
 * accidental mutation.
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
  return Object.freeze({
    userId: config.userId,
    tenantId: config.tenantId,
    roles: config.roles ? Object.freeze([...config.roles]) : undefined,
    permissions: config.permissions ? Object.freeze([...config.permissions]) : undefined,
    metadata: config.metadata ? Object.freeze({ ...config.metadata }) : undefined,
  });
}

/** Check whether the auth context has a specific role. */
export function hasRole(ctx: AuthContext, role: string): boolean {
  return ctx.roles?.includes(role) ?? false;
}

/** Check whether the auth context has a specific permission. */
export function hasPermission(ctx: AuthContext, permission: string): boolean {
  return ctx.permissions?.includes(permission) ?? false;
}
