<!--
Thanks for the PR! Please keep the description short but honest.
A maintainer will review once CI is green.
-->

## Summary

<!-- One or two sentences on *what* changed and *why*. -->

## Linked issues

<!-- `Closes #123`, `Refs #456`, or `N/A`. -->

## Affected packages

<!-- e.g. `harness-one`, `@harness-one/openai`, `@harness-one/redis`. -->

## Breaking change?

- [ ] No
- [ ] Yes — migration notes below:

<!-- If yes, describe the migration path for downstream users. -->

## Checklist

- [ ] Linked the relevant issue (or explained why none exists).
- [ ] Added or updated tests covering the change.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` passes locally.
- [ ] Updated `docs/architecture/` if this change touches
      `packages/core/src/{core,infra,guardrails,observe,orchestration}`.
- [ ] Added a changeset (`pnpm changeset`) if this change is user-facing
      or touches any `public` API.
- [ ] No new runtime dependencies added to `harness-one` (the core
      package stays zero-dep) — or justified below.
- [ ] Errors raised via `HarnessError` with a category and suggestion
      where applicable.

## Notes for reviewers

<!-- Call out anything reviewers should look at first, risky areas, or
     decisions that deserve a second opinion. Delete if not needed. -->
