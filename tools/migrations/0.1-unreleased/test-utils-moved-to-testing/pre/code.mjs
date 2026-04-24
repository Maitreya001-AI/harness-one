// PRE-migration: import test doubles from harness-one/advanced.
//
// This must FAIL against the current build. If it silently succeeds,
// harness-one/advanced still re-exports createMockAdapter and the
// MIGRATION.md entry is wrong — fix the entry or the export, don't
// loosen this fixture.

import { createMockAdapter } from 'harness-one/advanced';

const adapter = createMockAdapter({ responses: [] });
console.log('pre: createMockAdapter loaded:', typeof adapter);
