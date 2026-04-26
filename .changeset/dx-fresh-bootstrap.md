---
'harness-one': patch
---

DX: new `pnpm fresh` root script handles first-time bootstrap in one
command — `install` → build every `packages/*` `dist/` → `typecheck`
→ `test`. Apps consume harness-one via package.json `exports`
pointing at `dist/`, so the first `pnpm typecheck` after a clone
needs the dist to exist. `pnpm fresh` makes this a single command.

`CONTRIBUTING.md` updated to surface the new shortcut and document
the manual flow (`pnpm install && pnpm -r --filter './packages/*'
build && pnpm typecheck`) for users who prefer fine-grained
control.

Closes HARNESS_LOG research-collab L-008.
