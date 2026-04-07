# Code Quality Review Report

**Score**: 7.5/10 | **Findings**: 14 (1 Critical, 4 Major, 6 Minor, 3 Suggestion)

## Critical
- **CQ-001**: compress.ts treats `budget` as message count, not token count — all 4 strategies affected

## Major
- **CQ-002**: budget.ts throws plain Error instead of HarnessError
- **CQ-003**: Pipeline config shape deviates from ADR (requires {name, guard} vs plain Guardrail)
- **CQ-004**: JsonSchema interface has mutable fields (inconsistent with readonly convention)
- **CQ-005**: AgentLoop no cleanup on generator .return()/.throw()

## Minor
- CQ-006: json-schema strictEqual incomplete for object/array enums
- CQ-007: packContext O(n²) token counting during trim
- CQ-008: Rate limiter LRU indexOf is O(n)
- CQ-009: Content filter stateful RegExp with global flag risk
- CQ-010: Self-healing ignores modify verdict's modified content
- CQ-011: Pipeline fail-open skips event logging

## Suggestions
- CQ-012: Token estimator global registry is mutable singleton
- CQ-013: cache-stability JSON.stringify is order-dependent
- CQ-014: Missing empty-input tests for compress strategies
