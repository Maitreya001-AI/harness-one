---
'harness-one': patch
---

Test-only fix for a Windows-only flake in
`createAdapterContractSuite > stream() aborts mid-iteration when
simulateTiming is on and signal fires`.

The shared `stream-simple.jsonl` cassette spans only ~15ms total.
Windows `setTimeout` has ~15ms minimum granularity (vs sub-ms on
Linux/macOS), so the test's 5ms abort timer fired AFTER the cassette
finished — the for-await loop completed normally, the stream
resolved, and `.rejects.toBeInstanceOf(Error)` failed.

Replaced the shared cassette with a self-contained inline cassette
materialised to a temp file with chunks at 0/100/200/300ms and
abort scheduled at 50ms. Even when Windows rounds 50ms up to ~60ms,
the abort lands well inside the 100→200ms inter-chunk wait —
deterministic on every supported platform.

No production-code changes. Affects test infrastructure only.
