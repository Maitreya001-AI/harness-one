---
'harness-one': patch
---

Release-engineering: rewrite `version-packages.yml` so the auto-generated
"Version Packages" PR can be squash-merged from the GitHub UI without
any maintainer-side scripting.

Two long-standing blockers stacked on every release:

1. **`required_signatures` ruleset** rejected the bot's commit because
   `GITHUB_TOKEN` cannot sign commits.
2. **`required_status_checks`** could not be satisfied because GitHub
   deliberately does NOT trigger downstream workflows on
   `GITHUB_TOKEN` pushes (recursion guard).

The new workflow:

- Replaces `changesets/action`'s git-push step with a GraphQL
  `createCommitOnBranch` mutation. GitHub server-side signs the
  resulting commit (verified ✓), satisfying `required_signatures`
  with no signing key, App, or PAT setup needed.
- Explicitly invokes `gh workflow run --ref changeset-release/main`
  on each required CI workflow (`ci.yml`, `api-check.yml`,
  `codeql.yml`) so they produce check-runs at the bot PR's HEAD SHA.
- Adds `workflow_dispatch:` triggers to those required workflows so
  the dispatch is a no-op for ordinary contributors but legal for
  the version-packages step to invoke.

`tools/sign-changeset-release-pr.sh` (added in #44) remains as a
documented escape hatch should the workflow ever fail.
