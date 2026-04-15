/**
 * Template for the 'session' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules session`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import { createSessionManager } from 'harness-one/session';

// 1. Create a session manager with TTL and LRU eviction
const sm = createSessionManager({
  maxSessions: 100,
  ttlMs: 30 * 60 * 1000, // 30 minutes
  gcIntervalMs: 60_000,
});

// 2. Listen for session events
sm.onEvent((event) => {
  console.log(\`Session \${event.type}: \${event.sessionId}\`);
});

// 3. Create and access sessions
const session = sm.create({ userId: 'alice', plan: 'pro' });
console.log('Created:', session.id, session.metadata);

const accessed = sm.access(session.id);
console.log('Accessed:', accessed.lastAccessedAt);

// 4. Lock a session for exclusive use (e.g., during writes)
const { unlock } = sm.lock(session.id);
try {
  // Critical section -- session is locked
  console.log('Session locked for exclusive access');
} finally {
  unlock();
}

// 5. List active sessions and run garbage collection
console.log('Active sessions:', sm.activeSessions);
const removed = sm.gc();
console.log('GC removed:', removed, 'expired sessions');

// 6. Clean up when done
sm.dispose();
`;
