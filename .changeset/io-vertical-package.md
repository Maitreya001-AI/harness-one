---
'harness-one': minor
---

Ship `harness-one/io` — a vertical primitive for filesystem safety
shared by every coding-agent-shaped tool.

**New subpath** `harness-one/io` exports:

- `resolveWithinRoot(root, userPath)` — workspace containment with the
  realpath-existing-prefix dance, defeats macOS `/var → /private/var`
  symlink-escape false positives and rejects symlink prefixes that
  point outside the root. Throws `IO_PATH_ESCAPE` when containment
  fails, `IO_PATH_INVALID` for empty / NUL paths.
- `safeReadFile(path, opts)` — TOCTOU-safe read. Opens the fd FIRST
  then stats it, eliminating CWE-367 race conditions by construction.
  Supports `maxBytes`, `requireFileKind`, `encoding: 'utf8' | 'buffer'`,
  and `truncateOnOverflow`. Throws `IO_FILE_TOO_LARGE` /
  `IO_NOT_REGULAR_FILE` for actionable failure branching.
- `splitPath(p)`, `toPosix(p)`, `toFileUri(workspace, rel)` —
  cross-platform string-shape helpers. Critical for LSP integrations
  and sensitive-name predicates that must behave consistently on
  Windows + macOS + Linux.
- Auxiliary: `canonicalizeRoot`, `canonicalizeRootSync`,
  `realpathExistingPrefix`, `assertContainedIn`, `isContainedIn`.

**New error codes** added to `HarnessErrorCode`:
`IO_PATH_ESCAPE`, `IO_PATH_INVALID`, `IO_FILE_TOO_LARGE`,
`IO_NOT_REGULAR_FILE`.

**Why**: `apps/coding-agent` discovered each of these as production
bugs (HARNESS_LOG entries HC-002 macOS realpath, HC-018 CodeQL
`js/file-system-race` CWE-367, HC-019 Windows-only path-separator
regressions). Centralising them means downstream apps inherit the
hardening automatically.

**Migration**: `apps/coding-agent` updated to consume the new module.
`tools/paths.ts.resolveSafePath` now delegates to `resolveWithinRoot`
and layers the coding-agent-specific sensitive-name policy on top;
`tools/read_file.ts` and `tools/grep.ts` use `safeReadFile`;
`tools/lsp/client.ts.uri()` delegates to `toFileUri`. The duplicated
in-app implementations are deleted.
