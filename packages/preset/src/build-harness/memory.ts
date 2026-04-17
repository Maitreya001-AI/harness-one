/**
 * Memory-store factory helper — picks between Redis-backed and in-memory
 * {@link MemoryStore} implementations based on the harness config. Extracted
 * from the monolithic `index.ts`; behavior unchanged.
 *
 * @module
 */

import { createInMemoryStore } from 'harness-one/memory';
import type { MemoryStore } from 'harness-one/memory';
import { createRedisStore } from '@harness-one/redis';

import type { HarnessConfig } from './types.js';

/**
 * Build the default {@link MemoryStore} for a harness config.
 *
 * When `config.redis` is supplied the Redis-backed store is used; otherwise
 * an in-process store is returned. Callers that pass `config.memoryStore`
 * bypass this helper entirely.
 */
export function createMemory(config: HarnessConfig): MemoryStore {
  if (config.redis) {
    return createRedisStore({ client: config.redis });
  }
  return createInMemoryStore();
}
