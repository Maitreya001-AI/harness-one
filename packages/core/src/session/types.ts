/**
 * Type definitions for the session management module.
 *
 * @module
 */

import type { SessionId } from '../core/types.js';

/** A managed session. */
export interface Session {
  readonly id: SessionId;
  readonly createdAt: number;
  readonly lastAccessedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly status: 'active' | 'locked' | 'expired';
}

/** An event emitted during session lifecycle. */
export interface SessionEvent {
  readonly type: 'created' | 'accessed' | 'locked' | 'unlocked' | 'expired' | 'destroyed' | 'evicted';
  readonly sessionId: SessionId;
  readonly timestamp: number;
  /** Present on 'evicted' events to indicate the reason for eviction. */
  readonly reason?: string;
}
