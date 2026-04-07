# Phase 5 Red Team Arbitration

## Verdict: BLOCKERS FOUND — Proceed to Phase 6

## Combined Findings (Code Quality + Security)

### BLOCKERS (must fix before release)
| ID | Source | Issue | Severity |
|----|--------|-------|----------|
| CQ-001 | Quality | compress budget treated as message count, not tokens | CRITICAL |
| SEC-001 | Security | Unicode homoglyph injection bypass | CRITICAL |
| SEC-002 | Security | Negative token budget underflow | CRITICAL |
| SEC-003 | Security | Newline/markdown injection bypass | HIGH |
| SEC-005 | Security | Fail-open silent guardrail skip | HIGH |
| CQ-002 | Quality | Plain Error thrown instead of HarnessError | MAJOR |
| CQ-005 | Quality | No generator cleanup on .return()/.throw() | MAJOR |

### SHOULD FIX (recommended but not blocking)
| ID | Source | Issue | Severity |
|----|--------|-------|----------|
| SEC-004 | Security | Self-healing second-order injection risk | HIGH |
| SEC-010 | Security | Pattern source leakage in error messages | LOW |
| CQ-003 | Quality | Pipeline config shape deviates from ADR | MAJOR |
| CQ-009 | Quality | Content filter stateful RegExp risk | MINOR |
| CQ-010 | Quality | Self-healing ignores modify content | MINOR |
| CQ-011 | Quality | Fail-open doesn't log skipped guardrails | MINOR |

### DEFER (acceptable for v0.1)
- CQ-004: JsonSchema mutable fields
- CQ-007: O(n²) packContext trimming
- CQ-008: O(n) LRU in rate limiter
- SEC-006-009: Medium severity items (document as known limitations)

## Route: P5 → P6 (fix blockers) → P5 re-review → P7
