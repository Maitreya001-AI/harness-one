---
'harness-one': minor
---

`AgentLoop.run()` now emits a leading `iteration_start` event before
the terminal `error` + `done` pair on every pre-iteration termination
path: pre-abort, max_iterations, token_budget, duration_budget. The
contract is now uniform — every `done` is preceded by at least one
`iteration_start`.

**Why**: orchestrators (and any consumer driving a state machine off
event types) used the `iteration_start` event to transition out of the
initial `planning` state. With a pre-aborted signal the loop emitted
a single `done` (or no events at all) and orchestrators got stuck in
`planning`, requiring an awkward `planning → aborted` recovery branch
in user code (HARNESS_LOG HC-010).

The synthetic `iteration_start` carries the iteration number that
*was about to run* when termination fired (e.g. `1` for pre-abort,
`maxIterations + 1` for budget exhaustion). The full `startIteration`
ceremony (span open, hook fire, conversation pruning) is NOT
performed because no real iteration runs — this is a contract event,
not a real iteration.

**Migration**: consumers that exhaustively switched on event types
will now see one extra `iteration_start` per terminated run. This is
additive and matches what the no-termination path already produced,
so most code only needs a comment confirming the assumption is now
unconditional.
