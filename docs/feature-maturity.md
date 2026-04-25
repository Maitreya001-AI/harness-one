# Feature Maturity

Not all features are at the same maturity level. This table clarifies what's
production-ready vs. what requires additional work.

| Feature | Maturity | Notes |
|---------|----------|-------|
| Agent Loop (core) | Production | Token budget, abort, streaming, tool timeout |
| Adapters (anthropic, openai) | Production | Full chat + streaming support |
| Tool System | Production | Schema validation, rate limiting, namespacing |
| Guardrails Pipeline | Production | Fail-closed, PII detection, injection detection |
| Self-Healing Guardrails | Production | Retry with exponential backoff |
| Observability (tracing, spans) | Production | Langfuse, OpenTelemetry exporters |
| Cost Tracking | Production | Model pricing, budget alerts, auto-stop |
| Memory System | Production | In-memory, file-system, Redis backends |
| Session Management | Production | TTL, LRU eviction, locking |
| Evaluation Framework | Production | Scorers, quality gates, generator-evaluator |
| RAG Pipeline | Production | Loaders, chunking, in-memory retriever |
| Prompt Engineering | Production | Builder, registry, skill engine |
| Context Engineering | Production | Budget, packing, compression, checkpoints |
| Multi-Agent Orchestration | Production | Agent pool, handoff, context boundaries |
| Fallback Adapter | Production | Circuit-breaker with mutual exclusion |
| Circuit Breaker | Production | Prevents cascade failures when LLM provider is down |
| Graceful Shutdown | Production | SIGTERM/SIGINT → drain → dispose handler |
| Failure Taxonomy | Monitoring | Classifies failures; requires manual action |
| Drift Detection | Advisory | Detects metric drift; no auto-remediation |
| Component Registry | Tracking | Tracks retirement conditions; no CI enforcement |
| Progressive Disclosure | Manual | Requires explicit `advance()` calls |
| Context Boundaries | Advisory | Access control is advisory, not enforced |
| Data Flywheel (eval) | Passive | Extracts low-score cases; manual re-eval |
| Resilient Loop | New | Outer retry with fresh context (REQ-015) |
| Dataset Export | New | Trace-to-JSONL for fine-tuning (REQ-018) |
