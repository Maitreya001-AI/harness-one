---
"harness-one": minor
"@harness-one/preset": minor
"@harness-one/redis": minor
"@harness-one/langfuse": patch
"@harness-one/anthropic": patch
"@harness-one/openai": patch
"@harness-one/opentelemetry": patch
---

Closes 50 findings from the 2026-04-12 7-axis architecture review:
TraceExporter lifecycle hooks actually invoked, persistence-boundary
schema validation, harness.run({ sessionId }), guardrail trace events,
hot-path performance, extensibility seams (Tool middleware, MemoryStore
capabilities/writeBatch, ConversationStore capabilities, createAgentLoop
factory, MemoryStore testkit, provider spec), observability enrichment
(iteration/tool span attributes, adapter_retry events, strict CostTracker),
release pipeline (changesets + CI coverage enforcement + sourcemap check).

Breaking:
- HarnessConfig.langfuse is now validated at construction
- Memory persistence paths throw STORE_CORRUPTION on shape mismatch
- AgentLoop.run() is no longer re-entrant

See CHANGELOG.md [0.2.0] for the full list.
