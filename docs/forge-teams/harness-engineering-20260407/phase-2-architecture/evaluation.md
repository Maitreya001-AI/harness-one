# Architecture Evaluation

## Scoring Matrix

| Criterion (weight) | Proposal A: Minimal Composable | Proposal B: Production DX | Winner |
|---|---|---|---|
| Feasibility (25%) | 8/10 | 8/10 | Tie |
| Maintainability (25%) | 9/10 | 7/10 | A |
| Performance (20%) | 9/10 | 8/10 | A (marginal) |
| Security (15%) | 7/10 | 9/10 | B |
| Tech Debt Risk (15%) | 8/10 | 7/10 | A |
| **Weighted Score** | **8.35** | **7.80** | **A wins** |

## Decision: Hybrid — A's foundation + B's best ideas

### Adopted from Proposal A (base)
- Function-first for stateless operations
- Factory functions (createPipeline, createRegistry, createBudget)
- Guardrails as plain functions for custom impls
- Minimal JSON Schema validator in _internal/
- Opaque state via closures for most factories
- No branded types (v0.1 simplicity)
- No builder patterns (factory functions sufficient)

### Adopted from Proposal B (cherry-picked)
- Rich error hierarchy: HarnessError with code + suggestion
- 3-way GuardrailVerdict: allow | block | modify
- Core defines shared Message type (other modules import from core/types)
- AgentLoop as class with .run() returning AsyncGenerator (genuinely stateful)
- ToolResult with category + suggestedAction + retryable
- CompressionStrategy as named interface (extensible)
- Dedicated errors/ module

### Rejected from both
- Builder patterns (B) — insufficient value for 3-5 option configs
- Branded types (B) — too much friction for v0.1
- Result<T,E> type (B) — plain unions sufficient
- Zero core deps (A) — sharing Message type via core is cleaner
