# Architecture Proposal B: Type-Safe Composable Multi-Agent Infrastructure

**Architect**: Architect B
**Philosophy**: Extensibility & safety first, compile-time guarantees, shared protocols
**Estimated Effort**: ~7-8 days (includes shared abstractions)

## Key Design Choices

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Shared protocols | Disposable + Subscribable interfaces | Unified lifecycle and event patterns |
| ID safety | Branded types (AgentId, CheckpointId) | Compile-time ID mixup prevention |
| Pool acquire config | Per-acquire PoolAgentConfig | Flexible per-agent configuration |
| Handoff | Generic HandoffPayload<TMeta> | Type-safe custom metadata |
| CheckpointStorage | Async interface | Supports persistent backends natively |
| Boundary | AccessRule with readers/writers arrays | Fine-grained per-prefix control |
| Failure detection | FailureDetectionContext (events-based) | Richer signal than Trace alone |
| Cache monitor | Trend analysis via linear regression | Proactive degradation detection |

## 6 ADRs Documented

1. Shared Disposable + Subscribable protocols
2. Branded types for IDs
3. Handoff as orchestrator layer
4. Checkpoint = messages only
5. Failure detectors as pure functions
6. Context boundary as wrapper

## Architecture Highlights

- **Shared Disposable + Subscribable<TEvent>** protocols across all capabilities
- **Branded types** (AgentId, CheckpointId) for compile-time ID safety
- **Generic HandoffPayload<TMeta>** for type-safe metadata
- **Async CheckpointStorage** interface for persistent backend support
- **FailureDetectionContext** uses AgentEvent[] instead of Trace for richer signals
- **CacheMonitor with trend analysis** (linear regression on bucket hit rates)
- **ContextBoundary with violation tracking** and configurable read/write modes
- **Events on pool, handoff, boundary** for external monitoring integration

(See full proposal for complete type definitions, implementation details, and test strategy)
