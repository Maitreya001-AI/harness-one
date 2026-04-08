// Session module — public exports

// Types
export type { Session, SessionEvent } from './types.js';

// Manager
export type { SessionManager } from './manager.js';
export { createSessionManager } from './manager.js';

// Conversation persistence
export type { ConversationStore } from './conversation-store.js';
export { createInMemoryConversationStore } from './conversation-store.js';

// Auth context & multi-tenancy
export type { AuthContext } from './auth.js';
export { createAuthContext, hasRole, hasPermission } from './auth.js';
