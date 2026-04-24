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
2. **Version bump PR.** `@changesets/cli` is configured in
   `.changeset/config.json`; when it's run locally (or via a future
   changesets GitHub Action) it opens a "Version Packages" PR that
   consumes the pending changesets.
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
