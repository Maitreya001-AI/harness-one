/**
 * Tenant-aware key construction for the Redis memory store.
 *
 * Wave-16 M2 extraction. Owns the "which Redis key does this entry / index
 * live at" concern so the factory body in `index.ts` can focus on lifecycle.
 * Keeping this split also makes it trivial to reuse the same key shape from
 * a future ops/admin CLI without importing the whole store.
 *
 * @module
 * @internal
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';

/**
 * Resolved tenant namespace + precomputed key templates. The factory builds
 * one instance at construction time; every CRUD path reads from it without
 * re-validating or re-splitting the prefix.
 */
export interface RedisKeyspace {
  /** Returns the entry-payload key for a given entry id. */
  entryKey(id: string): string;
  /** Redis SET key that enumerates every entry id for this tenant. */
  readonly indexKey: string;
  /** The resolved tenant id (after defaulting). Exposed for logs. */
  readonly tenantId: string;
}

/** Minimal logger shape shared with the store. */
interface WarnLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Resolve tenancy from the user-supplied prefix + tenantId. Warns exactly
 * once (via the injected logger) when tenantId is omitted, and throws a
 * `CORE_INVALID_CONFIG` HarnessError if the tenantId contains a colon —
 * colons are the key separator and allowing them would let a crafted id
 * break out of the tenant namespace.
 */
export function createRedisKeyspace(
  prefix: string,
  tenantId: string | undefined,
  logger: WarnLogger,
): RedisKeyspace {
  const effectiveTenantId = tenantId ?? 'default';
  if (tenantId === undefined) {
    logger.warn(
      '[harness-one/redis] createRedisStore() invoked without tenantId; defaulting to "default". Multi-tenant deployments MUST set RedisStoreConfig.tenantId per tenant to prevent cross-tenant reads.',
    );
  }
  if (effectiveTenantId.includes(':')) {
    throw new HarnessError(
      `Invalid tenantId "${effectiveTenantId}": colon is the key separator and is reserved`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Use URL-safe characters only',
    );
  }
  const indexKey = `${prefix}:${effectiveTenantId}:__keys__`;
  return {
    entryKey(id: string): string {
      return `${prefix}:${effectiveTenantId}:${id}`;
    },
    indexKey,
    tenantId: effectiveTenantId,
  };
}
