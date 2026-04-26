---
'harness-one': minor
---

Add `ToolRegistry.executeByName(name, args)` convenience method.

The existing `execute(call: ToolCallRequest)` API takes the same shape
the AgentLoop passes through, but ad-hoc callers (runbooks, tests,
custom drivers) typically have just `(name, args)` and were forced to
fabricate a `ToolCallRequest` envelope every time — including the
JSON-string serialisation of `arguments` that confuses first-time users
(HARNESS_LOG HC-009).

`executeByName` synthesises the envelope internally with a unique
crypto-random call id, JSON-serialises the args (raising a validation
error on cycles / BigInt / non-serialisable inputs), and forwards to
the existing `execute` path so middleware, validation, rate limits,
byte caps, and timeouts all apply identically.
