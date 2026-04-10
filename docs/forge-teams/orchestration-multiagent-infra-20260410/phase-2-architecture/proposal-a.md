# Architecture Proposal A: Flat Primitives — Simplicity & Performance First

**Architect**: Architect A
**Philosophy**: Minimal API surface, flat composition, performance by default
**Estimated Effort**: ~6.5 days

## Key Design Choices

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Pool acquire | Synchronous | No I/O involved, AgentLoop ctor is sync |
| Handoff serialization | JSON + `__handoff__:` prefix | Don't modify AgentMessage type |
| CheckpointStorage | Sync interface | 95% in-memory case, async adds unnecessary complexity |
| Boundary matching | Pure prefix | O(patterns), no regex overhead |
| Taxonomy trace feed | Manual classify() calls, no built-in TraceExporter | 4 lines of user glue code |
| Pool warm-up | Lazy on first acquire() | No wasted resources at construction |
| Types placement | Public types in module types.ts | Consistent with existing pattern |

## 7 ADRs Documented

1. Sync pool acquire (no Promise overhead)
2. Handoff payload serialization (JSON prefix, no type broadening)
3. CheckpointStorage sync interface
4. Context boundary prefix matching
5. No built-in TraceExporter adapter for taxonomy
6. Lazy pool warm-up
7. Type placement strategy

## Architecture Highlights

- **Zero shared abstractions** — each primitive is self-contained
- **No changes to existing implementation files** — only index.ts re-exports and types.ts extensions
- **Running aggregates** in cache monitor (O(1) getMetrics)
- **Lazy warm-up** in agent pool
- **Dual storage** in handoff (orchestrator queue + local inbox)
- **Auto-prune** in checkpoint manager

## Risks Identified

- Sync CheckpointStorage may limit persistent backends (Medium)
- Checkpoint memory for large conversations (Medium, mitigated by maxCheckpoints)
- Failure detector false positives (Medium, mitigated by confidence scoring)

(See full proposal for complete type definitions, implementation code, and test strategy)
