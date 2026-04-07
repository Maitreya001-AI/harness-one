# Risk Assessment Report

**Overall Risk Level**: MEDIUM | **Total Risks**: 19 (5 HIGH, 10 MEDIUM, 4 LOW)
**Verdict**: APPROVED WITH CONDITIONS

## Blocking Conditions (must resolve before P4)
1. **Core types frozen before parallel impl** — Wave 2 already gates Wave 3. T004 (core/types.ts) is implemented before any parallel track starts. ✅ Already addressed by plan structure.
2. **JSON Schema subset scope documented** — Must specify supported keywords before T002.

## JSON Schema Supported Subset (resolving condition #2)
Supported keywords for `_internal/json-schema.ts`:
- `type`: string, number, integer, boolean, array, object, null
- `properties`: nested schema objects
- `required`: array of required property names
- `items`: schema for array items
- `enum`: allowed values list
- `pattern`: regex for strings
- `minimum` / `maximum`: number bounds
- `minLength` / `maxLength`: string length bounds
- `default`: default values (passthrough, not injected)
- `description`: passthrough (not used in validation)

NOT supported (out of scope for v0.1):
- `$ref`, `$defs` (no schema references)
- `oneOf`, `anyOf`, `allOf` (no composition)
- `additionalProperties` (no property restriction)
- `if/then/else` (no conditionals)
- `format` (no format validation)
- Recursive/circular schemas

## Key Risk Mitigations Accepted
- EST-01: Context module re-estimated to 5.5 days (split T011 into sub-phases)
- TECH-01: AsyncGenerator edge case tests required for T007
- SEC-01: Unicode normalization added to injection detector requirements
- SEC-03: All 4 fail-closed error paths must have explicit tests
- INT-03: ToolResult → Message serialization pattern documented in integration test
- TECH-04: Rate limiter gets maxKeys LRU eviction option
- DEP-01: dependency-cruiser added to CI requirements

## Risk Heatmap
| Component | Overall |
|-----------|---------|
| core/ | HIGH (AsyncGenerator complexity + Message contract) |
| guardrails/ | HIGH (security edge cases) |
| context/ | MEDIUM (estimation risk) |
| tools/ | MEDIUM (json-schema dependency) |
| _internal/ | MEDIUM (foundational correctness) |
| Build/CI | LOW |
