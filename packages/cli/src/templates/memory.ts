/**
 * Template for the 'memory' module scaffold.
 *
 * Emitted into the user's project by `harness-one init --modules memory`.
 * Subpath literals in this template MUST match exports in the core package's
 * package.json (enforced by packages/cli/src/__tests__/templates-subpaths.test.ts).
 *
 * @module
 */

export const template = `import { createInMemoryStore, createRelay } from 'harness-one/memory';

// 1. Create a memory store
const store = createInMemoryStore();

// 2. Write memories with grades
const critical = await store.write({
  key: 'user-preference',
  content: 'User prefers TypeScript over JavaScript',
  grade: 'critical', // Never auto-compacted
  tags: ['preference', 'language'],
});

await store.write({
  key: 'chat-summary',
  content: 'Discussed project architecture',
  grade: 'useful',
  tags: ['summary'],
});

await store.write({
  key: 'temp-note',
  content: 'User said hello',
  grade: 'ephemeral', // First to be compacted
});

// 3. Query memories
const preferences = await store.query({ tags: ['preference'], limit: 5 });
console.log('Preferences:', preferences.length);

const allUseful = await store.query({ grade: 'useful' });
console.log('Useful memories:', allUseful.length);

// 4. Compact old memories
const compaction = await store.compact({ maxEntries: 10, maxAge: 86400000 });
console.log('Compaction removed:', compaction.removed);

// 5. Cross-context relay for session handoff
const relay = createRelay({ store });

await relay.save({
  progress: { step: 3, status: 'implementing' },
  artifacts: ['src/index.ts', 'src/utils.ts'],
  checkpoint: 'v1',
  timestamp: Date.now(),
});

const state = await relay.load();
console.log('Relay state:', state?.progress);
`;
