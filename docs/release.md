# Release Engineering

This document covers what a release of `harness-one` looks like from
the outside: how the npm tarballs get built, what they are signed
with, and how downstream consumers can verify them before trusting
any bytes.

It also documents the one-time manual configuration the repository
owner performs on npm itself. GitHub Actions cannot configure the
npm-side trusted-publisher record; that lives behind npm's web UI
and is a deliberate, out-of-band step.

## Contract at a glance

| Property                      | How it's enforced                                              |
| ----------------------------- | -------------------------------------------------------------- |
| Reproducible tarballs         | `.github/workflows/release-pack.yml` runs `pnpm check:pack` on every PR. |
| Release provenance (Sigstore) | `.github/workflows/release.yml` → `actions/attest-build-provenance@v1` attests each `.tgz`. |
| npm package authentication    | OIDC trusted publisher — no `NPM_TOKEN` secret in the repo.    |
| npm package signatures        | `npm publish --provenance`; enforced by `publishConfig.provenance: true` in every published `package.json`. |

## Release flow

1. **Accumulate changesets.** Contributors run `pnpm changeset` as
   part of any user-visible PR. Changesets land on `main`.
2. **Version bump PR.** `.github/workflows/version-packages.yml` runs
   on every push to `main`; when pending `.changeset/*.md` files exist
   it opens (or updates) a "Version Packages" PR via
   [`changesets/action`](https://github.com/changesets/action). The PR
   contains the proposed version bumps + changelog inserts.
3. **Merge the version PR.** Versions bump, CHANGELOG entries land,
   git tags get cut.
4. **Cut a GitHub Release.** `gh release create v<x.y.z> --generate-notes`
   against the just-merged bump commit. This is what triggers
   `release.yml` (`on: release: published`).
5. **Automated publish.** `release.yml` then:
   - Re-runs the full build + `pnpm check:pack` reproducibility gate.
   - Packs every published workspace package into `dist/tarballs/`.
   - Calls `actions/attest-build-provenance@v1` so every tarball has
     a Sigstore-signed provenance statement recorded on the public
     Rekor transparency log.
   - Publishes each tarball to npm via OIDC — no secret involved.

## One-time npm configuration (owner only)

Each published package needs a **trusted publisher** record on npm.
This replaces the classic `NPM_TOKEN` secret: npm verifies GitHub's
OIDC token against the record at publish time, so rotating or
leaking a long-lived token is no longer a risk.

For every package listed under `packages/*` that is not `"private": true`:

1. Open `https://www.npmjs.com/package/<name>/access` (you must be an
   owner of that package). First-time publishes: you'll need to do
   the initial `npm publish` with a classic token to claim the
   package name, then immediately revoke the token and switch to
   trusted publishing for subsequent versions.
2. Click **Settings** → **Trusted Publisher** → **Add trusted publisher**.
3. Fill in:
   - **Publisher**: GitHub Actions
   - **Organization or user**: `Maitreya001-AI`
   - **Repository**: `harness-one`
   - **Workflow filename**: `release.yml`
   - **Environment**: *(leave blank unless you also configure a GitHub
     Environment gate — we don't today)*
4. Save.

Repeat for every package. The concrete list today:

- `harness-one`
- `@harness-one/anthropic`
- `@harness-one/openai`
- `@harness-one/ajv`
- `@harness-one/devkit`
- `@harness-one/preset`
- `@harness-one/cli`
- `@harness-one/langfuse`
- `@harness-one/opentelemetry`
- `@harness-one/redis`
- `@harness-one/tiktoken`

Run `grep -L '"private": true' packages/*/package.json` to recompute
this list if packages are added/removed.

### Why OIDC and not `NPM_TOKEN`

A long-lived `NPM_TOKEN` stored in repo secrets is a standing-capability
credential: anyone who can execute a workflow on `main` (or who
compromises an Actions runner) can publish any version of any
package. Rotation is manual, leaks are discovered late, and the
blast radius is unbounded.

OIDC-based trusted publishing removes the secret entirely. Every
publish is anchored to a specific workflow file + git ref, and the
trust relationship is visible (and revocable) from npm's UI.

### Revoking trust

If `release.yml` ever looks suspicious — malicious PR merged,
compromised maintainer — open the same npm package settings page
and remove the trusted publisher record. Subsequent publishes fail
with 401 until a new record is added.

## Verifying a release (consumers)

There are two independent attestations on every release. Both chain
back to Sigstore's Rekor transparency log — verifying either is
sufficient to prove the bytes came from this repo, and verifying
both detects a compromise of just one path.

### 1. npm package provenance (`--provenance`)

Every tarball published via `release.yml` carries a Sigstore-signed
provenance statement produced by `npm publish --provenance`. The
signing intent is pinned in each `packages/*/package.json` as:

```json
"publishConfig": {
  "access": "public",
  "provenance": true
}
```

`publishConfig.provenance: true` makes the signing property
enforced-by-data: a future `npm publish` without `--provenance` still
produces a signed tarball, because the package-level config wins. The
CLI flag in `release.yml` is belt-and-braces, not load-bearing.

Consumers verify:

```bash
# Works from any installed project. Exits non-zero on missing or
# invalid signatures across the full dependency tree.
npm audit signatures

# Inspect the attestation for a specific version:
npm view harness-one@<version> dist.attestations
```

Internally `npm audit signatures` fetches the Sigstore bundle
attached to the package, checks the signing certificate against
`fulcio.sigstore.dev`, and verifies the Rekor log inclusion proof.
No local trust root is needed beyond the one npm ships.

For a sigstore-cli-style check (useful in CI pipelines that don't
have npm available):

```bash
# Extract the provenance bundle from an npm tarball:
curl -sL "$(npm view harness-one@<version> dist.tarball)" -o pkg.tgz
npm view harness-one@<version> dist.attestations.provenance.url \
  | xargs curl -sL -o provenance.intoto.jsonl

# Verify with sigstore-cli:
sigstore verify identity \
  --bundle provenance.intoto.jsonl \
  --cert-identity-regexp 'https://github.com/Maitreya001-AI/harness-one/\.github/workflows/release\.yml@refs/tags/.*' \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  pkg.tgz
```

### 2. GitHub Release asset provenance

`actions/attest-build-provenance@v1` emits a separate attestation
for each tarball, anchored to the GitHub Release (and thus to the
underlying git tag). To verify any asset downloaded from the
Releases page:

```bash
gh attestation verify \
  --owner Maitreya001-AI \
  <downloaded-tarball>.tgz
```

A passing `gh attestation verify` proves the `.tgz` was built by
`release.yml` on a specific commit of `Maitreya001-AI/harness-one` —
independent of whether npm has tampered with its mirror.

### Why two attestations

Path (1) protects installs via `npm install`. Path (2) protects
out-of-band distribution (e.g. an air-gapped mirror or the Release
page directly). Any attacker capable of forging one still has to
forge the other to stay consistent — or accept that consumers will
see mismatched attestations and reject the release.

---

## How the Version Packages PR auto-merges

The `Version Packages` PR is opened by `.github/workflows/version-packages.yml`
(rewritten in 2026-04 — was previously calling `changesets/action`).

The rewrite eliminates the historical "bot PR is blocked on `required_signatures`
+ `required_status_checks`" problem so a maintainer can squash-merge the PR
straight from the GitHub UI. **No local script, no GPG-key dance, no GitHub
App provisioning.**

### Why the old setup was blocked

`changesets/action` pushed its bumps using the workflow's `GITHUB_TOKEN`,
which compounds two GitHub Actions invariants:

1. **`GITHUB_TOKEN` cannot sign commits** → every push is rejected by the
   `required_signatures` ruleset on `main`.
2. **`GITHUB_TOKEN` pushes do not trigger downstream workflows** (recursion
   guard) → the `required_status_checks` matrix (`build (ubuntu-latest, 22)`,
   `api-extractor`, `Analyze (javascript-typescript)`, …) never even ran on
   the bot's PR, so it stayed `BLOCKED` indefinitely.

Both blockers had to be removed at once. The rewrite addresses each at the
workflow layer, with no maintainer-side configuration:

### How the new workflow gets around each blocker

1. **Verified commits via GraphQL `createCommitOnBranch`.** The workflow
   walks `git status --porcelain` after `pnpm exec changeset version`,
   builds a `FileChanges` payload (additions with base64 content +
   deletions), then calls `createCommitOnBranch` with `expectedHeadOid`
   for optimistic concurrency. Commits made via this API are
   **server-side signed by GitHub** — they appear as **verified** in the
   UI and satisfy `required_signatures`. No GPG key, no App, no PAT.

2. **Required CI explicitly dispatched at the bot SHA.** After the bot PR
   is opened/updated, the workflow runs:

   ```bash
   for wf in ci.yml api-check.yml codeql.yml; do
     gh workflow run "$wf" --ref changeset-release/main
   done
   ```

   Each `workflow_dispatch` produces check-runs at the bot PR's HEAD SHA,
   satisfying `required_status_checks`. The dispatched workflows are
   architecturally identical to their `pull_request`-triggered runs;
   only the trigger event differs.

   Required workflows (`ci.yml`, `api-check.yml`, `codeql.yml`) declare
   `workflow_dispatch:` in their `on:` block. This is a no-op for
   ordinary contributors — only `version-packages.yml` invokes it.

### Operator workflow

1. Land normal feature PRs that include `.changeset/*.md` files (no
   workflow change here).
2. After each merge to `main`, `version-packages.yml` runs. If pending
   changesets exist, it opens or updates a "Version Packages" PR.
3. Open the bot PR, confirm the version bumps + CHANGELOG entries look
   right, click **Squash and merge**.
4. The merge fires `auto-release.yml`, which creates the matching
   `vX.Y.Z` tag + GitHub Release, which fires `release.yml`'s OIDC
   trusted-publish lane to npm.

No manual cherry-picks, no local scripts, no maintainer-side secrets
beyond `NODE_AUTH_TOKEN` (already configured for `release.yml`).

### Escape hatches if the workflow breaks

If `createCommitOnBranch` ever fails (API change, file-size limit hit,
auth scope shift), open an issue and use one of:

- **GitHub App + `actions/create-github-app-token`** — replaces
  `GITHUB_TOKEN` everywhere. App-token pushes are auto-verified AND
  trigger downstream workflows. Most production-grade.
- **Personal Access Token** from an account with [vigilant signing](https://docs.github.com/en/authentication/managing-commit-signature-verification/displaying-verification-statuses-for-all-of-your-commits)
  enabled. Stop-gap only — PATs expire and are tied to one human.
- **`bypass_actors` on the ruleset** for the GitHub Actions Integration
  (`actor_id=15368`). Broader exemption than the workflow-level fix
  above; admin scope required. Only use if both options above are
  unavailable.
