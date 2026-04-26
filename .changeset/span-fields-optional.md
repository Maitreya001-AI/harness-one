---
'harness-one': minor
---

`Span.attributes`, `Span.events`, `Trace.userMetadata`, and
`Trace.systemMetadata` are now optional in the public type. The
TraceManager always populates them with empty containers when
materialising a real Span/Trace, so production readers do not observe
`undefined` — but test fixtures and exporter mocks no longer have to
spell out `attributes: {}` / `events: []` literals (HARNESS_LOG
HC-012).

Internal exporters (OTel, Langfuse) and analyzers
(failure-taxonomy, dataset-exporter) updated to defensively spread
`?? {}` / `?? []` so they tolerate the optional shape without
runtime regression.
