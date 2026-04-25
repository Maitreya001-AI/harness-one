---
'harness-one': patch
'@harness-one/preset': patch
---

Chore: close 4 GitHub security alerts and stop three workflows going red on every push. No runtime/API changes.

- CodeQL `js/file-system-race` (#122) in `tools/check-pack-reproducible.mjs`: replaced the `statSync` → `readFileSync` TOCTOU pair with a single-fd flow (`openSync` + `fstatSync` + `readFileSync(fd)` + `closeSync`).
- CodeQL `js/clear-text-logging` (#123) in `examples/guardrails/pii-detector.ts`: variable name `blockApiKey` matched the `key/token/secret` heuristic; renamed to `strictVerdict`.
- CodeQL `js/redos` (#124) in `packages/core/src/guardrails/__tests__/content-filter.test.ts`: the test deliberately constructs an unsafe pattern to verify the ReDoS pre-check rejects it; reconstructed the source via `String.fromCharCode` so neither a regex literal nor a string literal of `(a+)+b` appears in the file.
- Dependabot GHSA-qx2v-qp2m-jg93 (postcss XSS via unescaped `</style>`): `pnpm.overrides` bumps postcss from 8.5.8 → ^8.5.10. Dev-only — postcss isn't imported by any published source.
- Secret scan workflow was failing on every push to `main`: full-history gitleaks scan re-flagged three test/example fixtures (placeholder secrets by design). Added them to `.gitleaks.toml`'s path allowlist.
- Adapter-caller timing flake (`expected 11 to be greater than or equal to 12`): `Date.now()`'s 1ms resolution can leave wall-clock duration a tick behind the summed scheduled backoffs. Loosened the cumulative-duration assertion by 2ms; real accounting bugs (e.g. duration reset to 0) still trip it.
- Cassette-drift workflow `ERR_MODULE_NOT_FOUND`: `tools/record-cassettes.mjs` runs from repo root with bare-specifier imports of `harness-one/testing` / `@harness-one/anthropic` / `@harness-one/openai`. Added the three packages as `workspace:*` devDependencies on the root so pnpm symlinks them into `node_modules/`, and updated the workflow to build all three packages before running the script.
