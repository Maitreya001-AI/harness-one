/**
 * Task-id generation. Deterministic when a custom RNG is supplied (tests).
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

/** Generate a unique, time-prefixed task id. */
export function createTaskId(now: () => number = Date.now): string {
  const nonce = randomBytes(6).toString('hex');
  return `task_${now()}_${nonce}`;
}
