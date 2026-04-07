# Red Team Security Attack Report

**Findings**: 10 (2 CRITICAL, 3 HIGH, 4 MEDIUM, 1 LOW)

## CRITICAL
1. **Unicode homoglyph injection bypass** (CVSS 9.1) — injection-detector.ts lacks NFKC normalization
2. **Negative token budget underflow** (CVSS 8.6) — agent-loop.ts:117 no validation on usage values

## HIGH  
3. **Newline/markdown injection bypass** (CVSS 7.5) — patterns use literal spaces, no whitespace normalization
4. **Self-healing second-order injection** (CVSS 7.8) — attacker content passed to retry prompt
5. **Fail-open silent guardrail skip** (CVSS 7.2) — no event emitted when guardrail crashes in fail-open mode

## MEDIUM
6. Modify verdict not applied to subsequent guardrails (CVSS 6.5)
7. Extra properties pass JSON Schema validation (CVSS 5.5)
8. Unbounded conversation array growth in agent loop (CVSS 5.8)
9. ReDoS via schema pattern field (CVSS 5.3)

## LOW
10. Pattern source leakage in injection detector error messages (CVSS 3.7)
