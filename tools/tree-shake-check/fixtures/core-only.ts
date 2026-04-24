// tools/tree-shake-check/fixtures/core-only.ts
//
// Minimal consumer program: a user who only wants the primary agent-loop
// factory from `harness-one`. The tree-shake checker bundles this file with
// esbuild and asserts that the resulting output does NOT contain symbols
// from opt-in subsystems (RAG, evolve-check) — proving the curated root
// barrel stays lean.
//
// Sentinel: the `@@harness-one/sanity` string is grepped by the checker as
// proof that the fixture linked and the bundle is non-empty. It must not
// be mangled (string literals survive minification).

import { createAgentLoop } from 'harness-one';

console.log('@@harness-one/sanity', typeof createAgentLoop);
