---
"@harness-one/langfuse": patch
---

Annotate two intentional fire-and-forget flush promises with `void`
(cost-export, cost-tracker) so the newly-blocking
`@typescript-eslint/no-floating-promises` production gate passes. No
behavior change — both paths are drained by `dispose()`.
