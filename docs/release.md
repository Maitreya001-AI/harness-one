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

## Unblocking the Version Packages PR (interim workaround)

The `Version Packages` PR opened by `changesets/action` (e.g. PR
#34, #42) is **always blocked** on the `required_signatures`
ruleset for `main`, because:

1. The action pushes its bumps using the workflow's
   `GITHUB_TOKEN`, which cannot sign commits.
2. GitHub Actions deliberately does NOT trigger downstream
   workflows on commits pushed via `GITHUB_TOKEN` — so the
   `required_status_checks` matrix never even runs on the bot's
   PR, leaving it doubly blocked.

### Quick interim fix (one command)

A maintainer with a configured GPG/SSH signing key can re-issue
the bot's commit signed in one shot:

```bash
tools/sign-changeset-release-pr.sh <bot-pr-number>
```

The script:

1. Cherry-picks the bot commit onto a fresh `changeset-release/signed-<ts>`
   branch with `-S`.
2. Pushes it (which triggers fresh CI naturally — non-bot push).
3. Opens a superseding PR and enables auto-merge with `--squash`.
4. Closes the original bot PR.

After auto-merge lands the version bump on `main`, the
`auto-release.yml` workflow detects the `chore: version packages`
commit message, creates the matching `vX.Y.Z` tag + GitHub
Release, and `release.yml` fires the OIDC trusted-publish lane.

### Permanent fix (one-time maintainer setup)

Pick **one** of:

#### Option A — GitHub App (recommended)

The cleanest, most production-grade path. Commits made by a
GitHub App via `createCommitOnBranch` are automatically
**verified** by GitHub, and pushes from an App's installation
token DO trigger downstream workflows.

1. Create a new GitHub App on the maintainer org (Settings →
   Developer settings → GitHub Apps → New).
2. Permissions: `Contents: write`, `Pull requests: write`,
   `Metadata: read`.
3. Install the App on the `harness-one` repository.
4. Save `APP_ID` and `PRIVATE_KEY` as repository secrets.
5. Update `.github/workflows/version-packages.yml` to mint a
   token via [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token)
   and pass it as `GITHUB_TOKEN` to `changesets/action`.

#### Option B — Bypass actor on the ruleset

Faster but slightly looser security — relax the
`required_signatures` ruleset to allow `github-actions[bot]` to
push unsigned commits to `changeset-release/*` branches only:

```bash
# Requires admin scope on the repo.
gh api -X PATCH repos/Maitreya001-AI/harness-one/rulesets/15516811 \
  -f 'bypass_actors[][actor_id]=15368' \
  -f 'bypass_actors[][actor_type]=Integration' \
  -f 'bypass_actors[][bypass_mode]=always'
```

Note: the `Integration` actor type with `actor_id=15368` is the
GitHub Actions app. This permits ALL Actions runs to bypass the
signature requirement on `main`, not just changesets/action — a
broader exemption than Option A.

#### Option C — Personal Access Token

If the maintainer has [vigilant signing](https://docs.github.com/en/authentication/managing-commit-signature-verification/displaying-verification-statuses-for-all-of-your-commits)
enabled on their account, a fine-grained PAT with `Contents: write`
+ `Pull requests: write` will produce verified commits via the
SSH key bound to the maintainer's account.

1. Create the PAT scoped to `harness-one`.
2. Save as `RELEASE_BOT_PAT`.
3. Replace `secrets.GITHUB_TOKEN` with `secrets.RELEASE_BOT_PAT`
   in `version-packages.yml`.

The downside vs Option A: PATs expire and are tied to a single
human, which fails an audit-trail bus-factor check. Use only as a
stop-gap.
