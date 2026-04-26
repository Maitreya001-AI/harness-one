# HYPOTHESIS · 04-orchestration-handoff

> Frozen before any Build code was written; observed annotations added
> as the showcase actually ran.

---

## ✅ Expected to be smooth

1. **Mock adapter delivers a deterministic message every call.** The
   mock helper is well tested.

   *Observed*: ✅ Confirmed across 100 happy-path runs.

2. **`spawnSubAgent` returns a `SpawnSubAgentResult` shape with
   messages + usage + doneReason.** Type signature is clear.

   *Observed*: ✅ Result shape works as documented.

3. **No cross-run state pollution from running 100 sequential chains.**
   Each chain creates fresh adapters, fresh messages, fresh signals.

   *Observed*: ✅ Token counts identical across all 100 runs.

## ⚠️ Suspected to wobble

4. **Error propagation through `spawnSubAgent`.** Concern: does an
   adapter throw bubble up as a Promise rejection (clean), or get
   embedded in the result (foot-guny)?

   *Observed*: ⚠️ As suspected, and worse than expected — see
   FRICTION #1. spawnSubAgent silently records errors as
   `doneReason='error'` and resolves cleanly. **Highest-severity
   finding of this showcase.**

5. **Schema validation of handoff payload.** The PLAN's handoff
   primitive (`createHandoff`) has its own type-checking layer. Does
   it surface mismatches synchronously at handoff time, or async on
   downstream consumption?

   *Observed*: ⚠️ Not exercised in the MVP — `spawnSubAgent` doesn't
   use `createHandoff` and the PLAN path through the typed primitive
   wasn't built. Deferred to follow-up.

## ❓ Genuinely unknown

6. **Cascade abort latency under realistic loads.** Cancelled
   coordinator → both specialists abort within how many ms?

   *Observed*: ❓ Couldn't probe with mocks running in <1ms. See
   FRICTION #3 — a `createSlowMockAdapter` helper would unblock this.

7. **Trace tree completeness across `spawnSubAgent` boundaries.** Does
   each child agent get a child span under its parent's span, or does
   each become a root span?

   *Observed*: ❓ The MVP didn't wire `traceManager`. To answer this
   we need a trace exporter (even console) plus an assertion on the
   parent-child structure of the resulting span list. Logged as a
   follow-up rather than an MVP failure.

8. **Independent-budget enforcement when 2 specialists run in
   parallel.** If specialist A consumes 4500/5000 of its budget, does
   specialist B start with its own clean 5000?

   *Observed*: ❓ With matching mock adapters both consumed identical
   token amounts; no distinguishing signal. Same unblocker needed:
   slower / variable mocks.
