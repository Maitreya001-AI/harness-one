---
"@harness-one/devkit": patch
---

Re-introduce runtime-working `@deprecated` aliases for the eval scorers renamed
during the thin-harness naming cleanup, so SHA-pinned consumers are not broken
by the rename. `createRelevanceScorer`, `createFaithfulnessScorer`, and
`createLengthScorer` are now reference-identity re-exports of their
`createBasic*` counterparts, surfaced from the devkit root. They will be removed
one full major version after first release.
