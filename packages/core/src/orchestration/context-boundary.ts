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

import { HarnessError } from '../core/errors.js';
import type {
  BoundaryPolicy,
  BoundaryViolation,
  BoundedContext,
  SharedContext,
} from './types.js';

const MAX_VIOLATIONS = 1000;

/** Configuration for context boundary behavior. */
export interface ContextBoundaryConfig {
  /**
   * Fix 31: When true, read violations throw errors instead of returning undefined.
   * Default: false (advisory mode).
   */
  readonly strictMode?: boolean;
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

  if (policies) {
    for (const p of policies) {
      policyMap.set(p.agent, p);
    }
  }

  function recordViolation(violation: BoundaryViolation): void {
    if (violations.length >= MAX_VIOLATIONS) {
      violations.shift();
    }
    violations.push(violation);
  }

  function isAllowed(
    key: string,
    prefixes: readonly string[] | undefined,
    denyPrefixes: readonly string[] | undefined,
  ): boolean {
    // Deny takes precedence
    if (denyPrefixes) {
      for (const prefix of denyPrefixes) {
        if (key.startsWith(prefix)) return false;
      }
    }
    // No allow list = full access
    if (!prefixes) return true;
    // Allow list present — must match at least one
    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  function canRead(policy: BoundaryPolicy, key: string): boolean {
    return isAllowed(key, policy.allowRead, policy.denyRead);
  }

  function canWrite(policy: BoundaryPolicy, key: string): boolean {
    return isAllowed(key, policy.allowWrite, policy.denyWrite);
  }

  function createScopedContext(agentId: string): SharedContext {
    return {
      get(key: string): unknown {
        const policy = policyMap.get(agentId);
        if (policy && !canRead(policy, key)) {
          recordViolation({ type: 'read_denied', agentId, key, timestamp: Date.now() });
          // Fix 31: In strict mode, throw instead of returning undefined
          if (strictMode) {
            throw new HarnessError(
              `Agent "${agentId}" denied read access to key "${key}"`,
              'BOUNDARY_READ_DENIED',
              'Check the BoundaryPolicy for this agent',
            );
          }
          return undefined;
        }
        return context.get(key);
      },
      set(key: string, value: unknown): void {
        const policy = policyMap.get(agentId);
        if (policy && !canWrite(policy, key)) {
          recordViolation({ type: 'write_denied', agentId, key, timestamp: Date.now() });
          throw new HarnessError(
            `Agent "${agentId}" denied write access to key "${key}"`,
            'BOUNDARY_WRITE_DENIED',
            'Check the BoundaryPolicy for this agent',
          );
        }
        context.set(key, value);
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

    getViolations(): readonly BoundaryViolation[] {
      return violations;
    },
  };

  return bounded;
}
