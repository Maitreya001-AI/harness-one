# Phase 6: Fix Report

## 7 Blockers Fixed (TDD)

| Fix | Severity | File | Description |
|-----|----------|------|-------------|
| FIX-1 | CRITICAL | compress.ts | All 4 strategies now count actual tokens via estimateTokens() |
| FIX-2 | CRITICAL | injection-detector.ts | NFKC normalization + Cyrillic-to-Latin homoglyph map |
| FIX-3 | CRITICAL | agent-loop.ts | Math.max(0, value) clamps negative token values |
| FIX-4 | HIGH | injection-detector.ts | Whitespace normalization + markdown stripping |
| FIX-5 | HIGH | pipeline.ts | Fail-open mode emits events for crashed guardrails |
| FIX-6 | MAJOR | budget.ts, compress.ts | All throws use HarnessError with code + suggestion |
| FIX-7 | MAJOR | agent-loop.ts | try/finally cleanup on generator early termination |

## Test Results
- **Before fixes**: 206 tests passing
- **After fixes**: 223 tests passing (+17 regression tests)
- **Duration**: 700ms
- **Regressions**: 0
