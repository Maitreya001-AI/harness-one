---
'harness-one': patch
---

Release-engineering follow-up to #45: add `workflow_dispatch:` triggers
to the remaining 3 required-check workflows (`audit.yml`,
`migrations.yml`, `release-pack.yml`) and extend
`version-packages.yml`'s dispatch loop to cover them.

PR #45 dispatched only `ci.yml`, `api-check.yml`, `codeql.yml` — but
the `main` ruleset's `required_status_checks` also includes
`pnpm-audit`, `check-migrations`, `check-pack`, which are produced by
those three workflows. Without `workflow_dispatch:` on them the bot
PR (#46) was BLOCKED on those three checks despite verified commits +
all dispatched workflows green.

This PR completes the coverage so the bot PR is fully self-unblocking
from the GitHub UI: every required check-run lands at the bot PR's
HEAD SHA via dispatch.

Also restores `tools/sign-changeset-release-pr.sh` as the documented
escape hatch (per the existing `docs/release.md` "Unblocking the
Version Packages PR" section). The workflow is the primary path; the
script remains in the tree for the case where the workflow itself
breaks (createCommitOnBranch API change, file-size limit, etc.).
