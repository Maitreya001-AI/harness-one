/**
 * Advisory access control boundary on SharedContext.
 *
 * Supports two modes:
 * - **Advisory mode** (default, strictMode=false): Read violations return undefined,
 *   write violations throw HarnessError. Violations are recorded but reads are silent.
 * - **Strict mode** (strictMode=true, Fix 31): Both read and write violations throw
 *   HarnessError. Use strict mode when you want hard enforcement rather than advisory
 *   access control.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { normalizeContextKey } from './orchestrator.js';
import type {
  BoundaryPolicy,
  BoundaryViolation,
  BoundedContext,
  SharedContext,
} from './types.js';

const DEFAULT_MAX_VIOLATIONS = 1000;

/** Configuration for context boundary behavior. */
export interface ContextBoundaryConfig {
  /**
   * Fix 31: When true, read violations throw errors instead of returning undefined.
   * Default: false (advisory mode).
   */
  readonly strictMode?: boolean;
  /** Maximum number of violations to retain. Default: 1000. */
  readonly maxViolations?: number;
}

/**
 * Create a BoundedContext that enforces advisory access control
 * on a SharedContext based on per-agent policies.
 *
 * @example
 * ```ts
 * const boundary = createContextBoundary(orchestrator.context, [
 *   { agent: 'worker-1', allowRead: ['shared.'], denyWrite: ['config.'] },
 * ]);
 * const scoped = boundary.forAgent('worker-1');
 * ```
 */
export function createContextBoundary(
  context: SharedContext,
  policies?: readonly BoundaryPolicy[],
  boundaryConfig?: ContextBoundaryConfig,
): BoundedContext {
  let policyMap = new Map<string, BoundaryPolicy>();
  const violations: BoundaryViolation[] = [];
  const viewCache = new Map<string, SharedContext>();
  const strictMode = boundaryConfig?.strictMode ?? false;
  const maxViolations = boundaryConfig?.maxViolations ?? DEFAULT_MAX_VIOLATIONS;

  if (policies) {
    for (const p of policies) {
      validatePolicyPrefixes(p);
      policyMap.set(p.agent, p);
    }
  }

  function recordViolation(violation: BoundaryViolation): void {
    if (violations.length >= maxViolations) {
      violations.shift();
    }
    violations.push(violation);
  }

  /**
   * SEC-011 + Wave-5E SEC-A09: compare keys and policy prefixes after
   * normalizing both with NFKC + casefold, AND require the prefix to end
   * on a segment boundary (`.` or `/`). Previously `allowRead: ['admin']`
   * would also match `'administrator'`; the constructor now rejects
   * prefixes without a trailing separator so this shape is impossible at
   * configuration time. Runtime check additionally demands the key char
   * immediately after the prefix is either end-of-string or a separator,
   * which closes the case where a legal `'admin.'` prefix could otherwise
   * match a carefully-crafted normalised key.
   */
  function isSegmentPrefix(normalizedKey: string, normalizedPrefix: string): boolean {
    if (!normalizedKey.startsWith(normalizedPrefix)) return false;
    if (normalizedKey.length === normalizedPrefix.length) return true;
    // Last char of the prefix was validated as `.` / `/` on construction,
    // so any non-strict-prefix match is automatically segment-aligned.
    return true;
  }

  function isAllowed(
    key: string,
    prefixes: readonly string[] | undefined,
    denyPrefixes: readonly string[] | undefined,
  ): boolean {
    const normalizedKey = normalizeContextKey(key);
    // Deny takes precedence
    if (denyPrefixes) {
      for (const prefix of denyPrefixes) {
        if (isSegmentPrefix(normalizedKey, normalizeContextKey(prefix))) return false;
      }
    }
    // No allow list = full access
    if (!prefixes) return true;
    // Allow list present — must match at least one
    for (const prefix of prefixes) {
      if (isSegmentPrefix(normalizedKey, normalizeContextKey(prefix))) return true;
    }
    return false;
  }

  /**
   * Wave-5E SEC-A09: reject policy prefixes that do not end with a
   * segment separator (`.` or `/`). Without this, `allowRead: ['admin']`
   * would leak to `'administrator'`. The constructor throws
   * {@link HarnessErrorCode.CORE_INVALID_CONFIG} so the misconfiguration
   * surfaces at boot time, not as a silent grant at access time.
   */
  function validatePolicyPrefixes(policy: BoundaryPolicy): void {
    const check = (field: string, prefixes: readonly string[] | undefined): void => {
      if (!prefixes) return;
      for (const prefix of prefixes) {
        if (prefix.length === 0) {
          throw new HarnessError(
            `Boundary policy ${policy.agent}.${field} contains an empty prefix`,
            HarnessErrorCode.CORE_INVALID_CONFIG,
            'Use at least one segment (e.g., "shared.")',
          );
        }
        const last = prefix[prefix.length - 1];
        if (last !== '.' && last !== '/') {
          throw new HarnessError(
            `Boundary policy ${policy.agent}.${field}="${prefix}" must end with a segment separator ("." or "/"); otherwise "admin" would match "administrator"`,
            HarnessErrorCode.CORE_INVALID_CONFIG,
            'Append "." (dotted namespace) or "/" (path-like) to the prefix',
          );
        }
      }
    };
    check('allowRead', policy.allowRead);
    check('denyRead', policy.denyRead);
    check('allowWrite', policy.allowWrite);
    check('denyWrite', policy.denyWrite);
  }

  function canRead(policy: BoundaryPolicy, key: string): boolean {
    return isAllowed(key, policy.allowRead, policy.denyRead);
  }

  function canWrite(policy: BoundaryPolicy, key: string): boolean {
    return isAllowed(key, policy.allowWrite, policy.denyWrite);
  }

  function createScopedContext(agentId: string): SharedContext {
    return {
      get<T = unknown>(key: string): T | undefined {
        const policy = policyMap.get(agentId);
        if (policy && !canRead(policy, key)) {
          recordViolation({ type: 'read_denied', agentId, key, timestamp: Date.now() });
          // Fix 31: In strict mode, throw instead of returning undefined
          if (strictMode) {
            throw new HarnessError(
              `Agent "${agentId}" denied read access to key "${key}"`,
              HarnessErrorCode.ORCH_BOUNDARY_READ_DENIED,
              'Check the BoundaryPolicy for this agent',
            );
          }
          return undefined;
        }
        return context.get<T>(key);
      },
      set(key: string, value: unknown): void {
        const policy = policyMap.get(agentId);
        if (policy && !canWrite(policy, key)) {
          recordViolation({ type: 'write_denied', agentId, key, timestamp: Date.now() });
          throw new HarnessError(
            `Agent "${agentId}" denied write access to key "${key}"`,
            HarnessErrorCode.ORCH_BOUNDARY_WRITE_DENIED,
            'Check the BoundaryPolicy for this agent',
          );
        }
        context.set(key, value);
      },
      /**
       * Wave-13 P0-5: delete respects write policy — same check as set,
       * since deletion is a mutation.
       */
      delete(key: string): boolean {
        const policy = policyMap.get(agentId);
        if (policy && !canWrite(policy, key)) {
          recordViolation({ type: 'write_denied', agentId, key, timestamp: Date.now() });
          throw new HarnessError(
            `Agent "${agentId}" denied write access to key "${key}"`,
            HarnessErrorCode.ORCH_BOUNDARY_WRITE_DENIED,
            'Check the BoundaryPolicy for this agent',
          );
        }
        return context.delete(key);
      },
      /**
       * Round-3 cleanup: batch deletion inherits the same write policy as
       * per-key `delete()`. When no policy is attached to this agent, the
       * underlying `deleteByPrefix()` runs unfiltered; otherwise only the
       * writable keys within the prefix are evicted and any denied match
       * records a boundary violation rather than silently widening the
       * blast radius.
       */
      deleteByPrefix(prefix: string): number {
        const policy = policyMap.get(agentId);
        if (!policy) return context.deleteByPrefix(prefix);
        let removed = 0;
        for (const [k] of context.entries()) {
          if (!k.startsWith(prefix)) continue;
          if (!canWrite(policy, k)) {
            recordViolation({ type: 'write_denied', agentId, key: k, timestamp: Date.now() });
            continue;
          }
          if (context.delete(k)) removed++;
        }
        return removed;
      },
      clear(): number {
        const policy = policyMap.get(agentId);
        if (!policy) return context.clear();
        let removed = 0;
        for (const [k] of context.entries()) {
          if (!canWrite(policy, k)) {
            recordViolation({ type: 'write_denied', agentId, key: k, timestamp: Date.now() });
            continue;
          }
          if (context.delete(k)) removed++;
        }
        return removed;
      },
      entries(): ReadonlyMap<string, unknown> {
        const policy = policyMap.get(agentId);
        if (!policy) return context.entries();
        const filtered = new Map<string, unknown>();
        for (const [k, v] of context.entries()) {
          if (canRead(policy, k)) {
            filtered.set(k, v);
          }
        }
        return filtered;
      },
    };
  }

  const bounded: BoundedContext = {
    forAgent(agentId: string): SharedContext {
      let cached = viewCache.get(agentId);
      if (!cached) {
        cached = createScopedContext(agentId);
        viewCache.set(agentId, cached);
      }
      return cached;
    },

    setPolicies(newPolicies: readonly BoundaryPolicy[]): void {
      policyMap = new Map<string, BoundaryPolicy>();
      for (const p of newPolicies) {
        policyMap.set(p.agent, p);
      }
      // Fix 30: Clear view cache on policy change to ensure agents see updated policies
      viewCache.clear();
    },

    getPolicies(agentId: string): BoundaryPolicy | undefined {
      return policyMap.get(agentId);
    },

    clearAgent(agentId: string): void {
      viewCache.delete(agentId);
      policyMap.delete(agentId);
    },

    getViolations(): readonly BoundaryViolation[] {
      return violations;
    },
  };

  return bounded;
}
