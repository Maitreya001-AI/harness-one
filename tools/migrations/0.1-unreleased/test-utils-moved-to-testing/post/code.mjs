// POST-migration: import test doubles from harness-one/testing.
//
// This must SUCCEED against the current build and produce a usable
// mock adapter. If it fails, the new subpath we told users to migrate
// to isn't actually exporting what we promised.

import { createMockAdapter } from 'harness-one/testing';

const adapter = createMockAdapter({ responses: [] });
if (typeof adapter !== 'object' || typeof adapter.chat !== 'function') {
  throw new Error(
    `post-migration smoke: createMockAdapter() returned unexpected shape: ${typeof adapter}`,
  );
}
console.log('post: createMockAdapter loaded + returned usable adapter');
