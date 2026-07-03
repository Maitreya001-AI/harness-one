---
"harness-one": patch
---

TSDoc: cross-link resilience mechanisms to the selection guide

Added a `@see docs/guides/resilience.md` reference and a one-sentence
"when to use this vs. the alternatives" note to the TSDoc of the four
overlapping resilience mechanisms — `createFallbackAdapter`,
`createResilientLoop`, `createCircuitBreaker`, and the `AgentLoopConfig`
in-loop retry knobs (`maxAdapterRetries`). Comment-only; no public API or
runtime behavior change.
</content>
</invoke>
