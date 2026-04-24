# Contributing to harness-one

Thank you for your interest in contributing. harness-one is a monorepo of
framework-agnostic primitives for AI agent harness engineering. Every
contribution — from a typo fix to a new module — is welcome.

## Ground Rules

- Be respectful. See our [Code of Conduct](./CODE_OF_CONDUCT.md).
- Keep changes focused. One PR = one logical change.
- All code must carry tests. Near-100% test coverage is a project-wide bar.
- Prefer minimal, composable APIs. We ship primitives, not frameworks.

## Development Setup

This repo uses [pnpm workspaces](https://pnpm.io/workspaces).

**Prerequisites** (enforced by `engines` in `package.json` and a
`preinstall` check):

- Node.js `>= 18` (Node 20 LTS recommended).
- pnpm `>= 9`. Install with `corepack enable` or `npm i -g pnpm@9`.

```bash
# 1. Clone
git clone https://github.com/Maitreya001-AI/harness-one.git
cd harness-one

# 2. Install dependencies (workspace-aware)
pnpm install

# 3. Build and verify the full workspace
pnpm build
pnpm test
```

## Common Tasks

```bash
# Run the full test suite across every package
pnpm test

# Run tests with coverage (fails the build if coverage drops)
pnpm test:coverage

# Run ESLint across every package
pnpm lint

# Type-check every package (tsc --noEmit)
pnpm typecheck
```

Each individual package also supports these scripts scoped to its own source.

### Testing Conventions

The full testing strategy — unit / integration / conformance / property
tests, coverage gates, the RAG conformance harness, and how each package
layers on top — is documented in
[`docs/testing-plan.md`](./docs/testing-plan.md) (with per-track detail
under `docs/testing-plan/`). Read the relevant track before adding new
test files so your additions slot into the existing matrix instead of
duplicating it.

Near-100% coverage is the bar. PRs that drop coverage on `packages/core`
will be blocked by CI.

## Branching and Commits

- Target `main` for all pull requests.
- Write commits in imperative mood: `fix: handle empty tool arguments`.
- Prefix with a conventional-commit type when it helps (`feat:`, `fix:`,
  `docs:`, `refactor:`, `test:`, `chore:`). This is encouraged, not enforced.
- If your change is user-visible, add a [changeset](https://github.com/changesets/changesets):

  ```bash
  pnpm changeset
  ```

  Pick the appropriate bump level (patch / minor / major) and describe the
  change in one or two sentences. The file lands under `.changeset/` and is
  consumed by the release workflow.

## Commit Signing

Signed commits (`git commit -S`) are strongly recommended. If you have a GPG
or SSH signing key configured, please sign. Unsigned commits are still
accepted but must pass CI checks without exception.

## Pull Request Process

1. Fork the repo and create a feature branch.
2. Make your change. Add tests. Add a changeset if user-facing.
3. Run `pnpm lint && pnpm typecheck && pnpm test` locally.
4. Open a PR against `main`. Fill in the PR template:
   - What changed and why.
   - Affected packages.
   - Breaking-change note (if any).
5. A maintainer will review within a few days. Expect at least one round of
   feedback — we optimize for clarity and long-term maintainability.
6. Once approved and CI is green, a maintainer will merge. Squash-merge is
   the default.

### Review Expectations

Reviewers will check:
- Test coverage for new and changed code.
- API surface: is the new API necessary, minimal, and composable?
- Documentation: JSDoc on public exports, README updates for new features.
- No new runtime dependencies in `harness-one` (the core package is zero-dep).
- Error handling uses `HarnessError` with a category and suggestion.

## Reporting Issues

Please open an issue on GitHub:
https://github.com/Maitreya001-AI/harness-one/issues

When reporting a bug include:
- A minimal reproduction (a `.ts` file or a failing test is ideal).
- The package name and version (e.g. `harness-one@0.2.0`).
- Your Node.js version and OS.
- The expected versus actual behavior.

When proposing a feature:
- Describe the use case you cannot solve with the existing API.
- Sketch the proposed API shape.
- Note any alternatives you considered.

## Security

If you believe you have found a security vulnerability, do **not** open a
public issue. Email the maintainers privately via the contact address listed
on the GitHub profile at
https://github.com/Maitreya001-AI, or use GitHub's private
"Report a vulnerability" flow on the repository's Security tab.

## License

By contributing you agree that your contributions will be licensed under the
MIT License (see [LICENSE](./LICENSE)).
