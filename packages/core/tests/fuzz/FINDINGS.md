# Fuzz findings

Real bugs uncovered by the O1–O4 fuzz suite. Per Track O policy (see
`SECURITY.md` for the disclosure process), this worktree does NOT fix
source — each finding gets an issue to route through the coordinated
review. Once the corresponding fix lands, the fuzz filter below should
be removed so the property reclaims full coverage.

## F-O4-01 · Registry resolve throws TypeError on prototype-chain var names (FIXED)

**Discovered**: O4 property "declared-but-unset variables cause a HarnessError".
Shrunk counter-example: `variables: ['valueOf']` / `variables: ['toString']`.

**Observed behaviour (pre-fix)** — `createPromptRegistry().resolve(id, {})`
where the template declares a variable with the name of an
`Object.prototype` method threw `TypeError: rawValue.replace is not a
function` instead of the documented
`HarnessError(PROMPT_MISSING_VARIABLE)`.

**Root cause** — `packages/core/src/prompt/registry.ts:31` used
`if (!(varName in variables))`. The `in` operator walks the prototype
chain, so `'valueOf' in {}` is `true`. The loop then read
`variables['valueOf']` which returned `Object.prototype.valueOf` (a
function) and `.replace()` is not defined on functions — hence the
`TypeError` leaked to the caller.

**Severity**: Low-Medium. Denial of service against the prompt resolver
only; no data exfiltration. Callers that catch `HarnessError` for
missing vars mis-routed the failure.

**Fix** (same PR as the fuzz suite): switch the check to
`Object.prototype.hasOwnProperty.call(variables, varName)`. Regression
covered by `packages/core/src/prompt/__tests__/registry.test.ts`
(describe block `F-O4-01: prototype-chain variable names`, seven
`protoKeys`-parameterised assertions) AND by the O4 fuzz property that
no longer filters these names. The builder side (`createPromptBuilder`)
was already safe — variables live in a `Map`, not a plain object.

**Status**: Closed. Filter removed from fuzz arbitraries; property now
covers the full ASCII identifier range.
