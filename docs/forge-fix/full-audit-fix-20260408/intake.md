# Bug Fix Intake: Full Audit Remediation

## Source
Production readiness audit report (2026-04-08), 24 findings across 6 priority levels.

## Mode
Quick path for all — root causes already identified with exact file:line locations.

## Fix Groups (parallelized by independence)

### Group A: Adapter Fixes (anthropic + openai)
- F1: AbortSignal not propagated to SDK calls
- F2: No retry logic (enable SDK built-in retry)
- F3: Anthropic streaming duplicate done events
- F19: Unsafe type assertions in Anthropic
- F23: JSON.parse without try/catch in Anthropic

### Group B: Build & Package Config
- F8: Ajv build broken (require→import, @types/node)
- F9: Package export conditions order (types first)
- F17: LLMConfig index signature → separate `extra` field

### Group C: Full Package Type Safety
- F7: HarnessConfig client:unknown → discriminated union

### Group D: Core Module Fixes
- F6: GuardrailPipeline branded type → proper validation
- F11: Global mutable state → closures
- F12: FS store non-atomic writes → write-then-rename
- F14: Stack trace leakage → redact in LLM results
- F16: Injection detector false positives at high sensitivity
- F20: ReDoS in JSON schema validator
- F21: FS store sequential I/O → parallel reads
- F24: Rate limiter O(N) index rebuild

### Group E: External Integration Fixes
- F4: Redis query full table scan → batch optimization
- F5: Langfuse traceMap memory leak → LRU eviction
- F10: Langfuse list()/push() stubs → proper implementation
- F13: Langfuse CostTracker O(N) → running total
- F18: OTel span hierarchy → proper parent-child context
- F22: CostTracker unbounded records → ring buffer

### Group F: New Feature
- F15: Vector search → basic in-memory cosine similarity
