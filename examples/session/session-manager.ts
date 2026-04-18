/**
 * Example: SessionManager — TTL + LRU + exclusive locking + event bus.
 *
 * Shows the full lifecycle:
 *   - create / access / destroy
 *   - TTL-based expiry (lazy + gc()-triggered)
 *   - LRU eviction when `maxSessions` is hit
 *   - exclusive locking for "one-agent-per-session" critical sections
 *   - event bus subscription for audit logs
 *
 * Pairs with ConversationStore (see `harness-one/session`) if you need to
 * persist message history across sessions — that surface is independent.
 */
import {
  createSessionManager,
  createInMemoryConversationStore,
  createAuthContext,
  hasPermission,
} from 'harness-one/session';
import type { Session, SessionEvent } from 'harness-one/session';
import type { Message } from 'harness-one/core';

async function main(): Promise<void> {
  // ── 1. Construct the manager ─────────────────────────────────────────────
  const sm = createSessionManager({
    maxSessions: 10,      // LRU cap — oldest unlocked session evicted when full
    ttlMs: 60_000,        // 60s idle → expired (lazy check on access/list)
    gcIntervalMs: 30_000, // background GC every 30s (0 disables)
  });

  // Subscribe to lifecycle events. The bus is re-entrant safe — handlers
  // that trigger new events (e.g. destroy() inside onEvent) get queued.
  const audit: SessionEvent[] = [];
  sm.onEvent((event) => audit.push(event));

  // ── 2. Per-request session with auth context ─────────────────────────────
  const auth = createAuthContext({
    userId: 'alice',
    roles: ['admin'],
    permissions: ['session:lock', 'session:destroy'],
  });

  // AuthContext is stored in session metadata — use createAuthContext() first
  // so the object is deep-frozen and can't be mutated after being handed to the
  // manager.
  const session: Session = sm.create({
    userId: auth.userId,
    tenantId: 't-42',
    authContext: auth,
  });
  console.log('Created:', session.id, 'activeSessions:', sm.activeSessions);

  // ── 3. Exclusive lock — only one agent may `access()` while locked ───────
  if (hasPermission(auth, 'session:lock')) {
    const lock = sm.lock(session.id);
    try {
      // Critical section: do work that requires exclusive session state.
      // A concurrent `access()` throws HarnessError(SESSION_LOCKED).
      console.log('Locked; doing critical work…');
    } finally {
      lock.unlock(); // Always unlock — pattern parallels a mutex guard.
    }
  }

  // ── 4. Access updates lastAccessedAt (LRU refresh) ───────────────────────
  const fresh = sm.access(session.id);
  console.log('Accessed at:', new Date(fresh.lastAccessedAt).toISOString());

  // ── 5. ConversationStore is independent — persist message history ────────
  const convo = createInMemoryConversationStore({ maxMessagesPerSession: 1000 });
  const messages: Message[] = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
  ];
  await convo.save(session.id, messages);
  await convo.append(session.id, { role: 'user', content: 'Tell me more.' });
  const restored = await convo.load(session.id);
  console.log(`Conversation has ${restored.length} messages`);

  // Declare your backend's capabilities so callers can opt into optimisations:
  console.log('Store capabilities:', convo.capabilities);

  // ── 6. Manual GC + audit trail ───────────────────────────────────────────
  const pruned = await sm.gc();
  console.log(`GC removed ${pruned} expired session(s)`);
  console.log(`Audit events: ${audit.map((e) => e.type).join(', ')}`);

  // ── 7. Always dispose — clears GC timer and all session data ─────────────
  sm.dispose();
}

main().catch(console.error);
