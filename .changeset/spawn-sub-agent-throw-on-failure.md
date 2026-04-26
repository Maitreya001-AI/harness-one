---
'harness-one': major
---

`spawnSubAgent` now throws `HarnessError` on `error` and `aborted` terminal
states instead of resolving silently with `doneReason` set.

**Why**: the previous behaviour was a footgun — every caller that wrapped
`spawnSubAgent` in `try/catch` was silently fooled into treating failures
as successes (the Promise resolved either way, the only signal was a string
field on the result). See showcase 04's FRICTION_LOG entry.

**New contract** (Promise-idiomatic):

| `doneReason`         | Behaviour                                                     |
| -------------------- | ------------------------------------------------------------- |
| `end_turn`           | resolves with the result                                      |
| `max_iterations`     | resolves with the result (caller-set budget)                  |
| `token_budget`       | resolves with the result (caller-set budget)                  |
| `duration_budget`    | resolves with the result (caller-set budget)                  |
| `guardrail_blocked`  | resolves with the result (policy decision)                    |
| `aborted`            | **throws** `HarnessError(CORE_ABORTED)`                       |
| `error`              | **throws** `HarnessError(ADAPTER_ERROR)` with originating `cause` |

Soft budget exhaustion still resolves so callers can inspect partial work
they explicitly asked for.

**Migration**: replace any `if (result.doneReason === 'error') throw …` /
`if (result.doneReason === 'aborted') throw …` blocks with a `try/catch`.
The thrown `HarnessError` carries the originating exception as `cause` and
includes a `suggestion` field for diagnostics.
