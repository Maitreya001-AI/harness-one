# OpenSSF Best Practices — Passing-level self-assessment

This file is the working document for harness-one's application to the
**OpenSSF Best Practices Badge Program** (formerly CII Best Practices).
Filing the application itself is an owner action; this document exists so
reviewers can see exactly which criteria we already meet and which remain
open action items.

- Program home: <https://www.bestpractices.dev/>
- Criteria reference (Passing): <https://www.bestpractices.dev/en/criteria/0>

Legend:

- ✅ — already satisfied by the repository as of this PR.
- ⚠️ — partially satisfied; remaining action items enumerated inline.
- 📋 — not yet satisfied; action item owned by maintainers.

---

## Basics (6)

### 1. `description_good` — Description present

✅ `README.md` opens with a one-sentence description ("Universal primitives
for AI agent harness engineering...") and `What is Harness Engineering?`
expands it.

### 2. `interact` — Project URL (a/k/a discussion / issue tracker)

✅ GitHub issues are enabled; `package.json`'s `bugs.url` points to
`https://github.com/Maitreya001-AI/harness-one/issues`. `CONTRIBUTING.md`
documents how to file issues.

### 3. `contribution` — CONTRIBUTING present

✅ `CONTRIBUTING.md` at repo root. Covers setup, ground rules, PR flow,
changeset discipline, and testing requirements.

### 4. `contribution_requirements` — Requirements for contributions

✅ `CONTRIBUTING.md` covers style (lint/format), testing (near-100%
coverage bar), commit discipline (changesets), and signed DCO expectations
inherited from the GitHub default.

### 5. `license_location` / `floss_license` — OSI-approved license, at a well-known location

✅ `LICENSE` at repo root; MIT (OSI-approved).

### 6. `english` — Primary docs in English

✅ `README.md` is English (with a Chinese translation `README.zh-CN.md`
offered as a secondary convenience).

---

## Change Control (3)

### 7. `repo_public` — Public VCS

✅ Hosted on GitHub at
<https://github.com/Maitreya001-AI/harness-one>.

### 8. `repo_interim` — Interim changes tracked

✅ Every feature/fix lands via PR; `git log` preserves the full history.
Squashing is optional per PR, not enforced; interim commits survive on the
PR page.

### 9. `repo_distributed` — Distributed VCS

✅ Git.

### 10. `version_unique_numbering` + `release_notes`

✅ Changesets-driven semver releases. `.changeset/` accumulates per-PR
change notes; `pnpm release` produces a tagged release with aggregated
release notes.

⚠️ Action item: once the first tagged release ships, the generated
`CHANGELOG.md` in each `packages/*` should be cross-linked from the root
README "Releases" section.

---

## Reporting (4)

### 11. `report_process` — Documented reporting process for bugs

✅ `CONTRIBUTING.md` + GitHub issue templates document the process. Bugs
go to <https://github.com/Maitreya001-AI/harness-one/issues>.

### 12. `report_tracker` — Bugs tracked

✅ GitHub Issues.

### 13. `report_responses` — Maintainers respond to bug reports

⚠️ Project is young; no response-time history to report yet. Commitment:
respond to ≥50% of bug reports within 14 days. A baseline will be
published to `docs/security/` once the project has a full quarter of
activity.

### 14. `vulnerability_report_process` + `vulnerability_report_private`

✅ `SECURITY.md` at repo root documents the private disclosure channel
(GitHub private vulnerability reporting plus an email alias) and
explicitly prohibits filing public issues for security reports.

### 15. `vulnerability_report_response`

✅ `SECURITY.md` documents the response SLA: acknowledgement within 7
days, triage/assessment within 14 days, fix-or-mitigation within 30
days for high-severity issues.

---

## Quality (8)

### 16. `build` — Project builds from source

✅ `pnpm install --frozen-lockfile && pnpm build` rebuilds all packages.
Matrix-tested on Ubuntu, macOS, Windows (Node 18/20/22) in `ci.yml`.

### 17. `build_common_tools` — Standard build tools

✅ pnpm + tsup (both widely used, OSI-licensed, fetched through the
lockfile).

### 18. `build_floss_tools` — Toolchain is FLOSS

✅ Node.js, pnpm, tsup, tsc, vitest, eslint — all OSI-licensed.

### 19. `test` — Automated test suite

✅ Vitest, per-package, run on every PR via `ci.yml`. Coverage
thresholds (80 / 75) are enforced in `vitest.config.ts`.

### 20. `test_policy` — Contribution guide calls out tests

✅ `CONTRIBUTING.md` ground rules: "All code must carry tests.
Near-100% test coverage is a project-wide bar."

### 21. `tests_are_added` / `regression_tests_added50`

✅ Verified by requiring a changeset on every PR touching `packages/`
(`ci.yml` `changeset-check` job) plus coverage thresholds that would
fall if new code landed untested.

### 22. `warnings` / `warnings_fixed` / `warnings_strict`

✅ `eslint` + `tsc --strict`. `pnpm lint` is a required CI step;
warnings are treated as errors in `packages/*`.

### 23. `knowledge_secure_design` — Primary developers understand secure design

✅ `docs/architecture/05-guardrails.md` + the redact module
(`packages/core/src/infra/redact.ts`) + the SEC-001 markers in the code
demonstrate working knowledge of threat modeling, principle of least
privilege, and secure-by-default patterns.

---

## Security (5)

### 24. `dynamic_analysis` — Dynamic analysis (optional for Passing, required for Silver)

✅ Vitest coverage + CI fuzz-adjacent tests (redact adversarial tests
landing in this PR). Not required at Passing level but counted.

### 25. `dynamic_analysis_unsafe` / `dynamic_analysis_enable_assertions`

✅ `tsc --strict`; Node runs with default assertions. No unsafe
languages in use (TypeScript only).

### 26. `crypto_call` / `crypto_floss`

✅ We do not implement our own crypto. Any crypto comes from Node
stdlib or downstream SDK packages, both FLOSS and widely reviewed.

### 27. `vulnerabilities_fixed_60_days`

✅ `SECURITY.md` commits to fix-or-mitigation within 30 days for
high-severity issues, which exceeds this criterion's 60-day bar.

### 28. `vulnerabilities_critical_fixed`

✅ No known unfixed critical vulnerabilities. `pnpm audit
--audit-level=high --prod` is enforced by `.github/workflows/audit.yml`
on every PR + weekly schedule.

---

## Analysis (3)

### 29. `static_analysis` — Static analysis applied

✅ `typescript-eslint` + `tsc --strict`. `pnpm lint` runs on CI.

### 30. `static_analysis_common_vulnerabilities` — CodeQL / Scorecard etc.

✅ As of this PR, `ossf/scorecard-action` runs on push to main + weekly
and uploads SARIF to GitHub code scanning. Dependabot covers dep-level
advisories.

### 31. `static_analysis_fixed`

✅ Same enforcement path. Any new high-severity Scorecard finding
shows up in the code-scanning tab and is triaged.

---

## Action-item summary (owner follow-ups, not in this PR)

1. ✅ **Best Practices application submitted** — project ID
   `12635` (passing level), viewable at
   <https://www.bestpractices.dev/projects/12635>. README badges in
   `README.md` and `README.zh-CN.md` now point to this project ID.
2. **Publish response-time metrics** — after 1 full quarter of issue
   activity, post aggregate stats to `docs/security/` to back criterion
   #13.
3. **Keep `SECURITY.md`'s supported-version table current** — the
   file already carries a `TODO(owner)` note to bump the matrix on
   every minor release.

---

## Badge

The README carries the live badge (project ID `12635`):

```markdown
[![OpenSSF Best Practices](https://bestpractices.coreinfrastructure.org/projects/12635/badge)](https://bestpractices.coreinfrastructure.org/projects/12635)
```
