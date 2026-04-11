# Fix Report: Full Production Audit — 67 Issues

**Date:** 2026-04-11
**Path:** Quick (all root causes known from audit)
**Fix Attempts:** 1 (5 parallel agents + 5 test fixes)
**Total Loop Iterations:** 1

## Verification

- **TypeScript:** All 9 packages compile clean (0 errors)
- **Tests:** 2,610 tests pass across 9 packages (0 failures)
- **Lint:** 0 errors, 33 warnings (all pre-existing)

## Changes by Wave

### Wave 1: Core Architecture (8 files modified)
- Input validation for `maxIterations`, `maxTotalTokens`, `maxStreamBytes`, `maxToolArgBytes`, `toolTimeoutMs` in AgentLoop
- Input validation for `budget` in compress(), `maxRetries` in self-healing, `maxSessions`/`ttlMs` in SessionManager, `maxTraces` in TraceManager
- Input validation for handoff `from`/`to` agent IDs
- Removed `cumulativeStreamBytes = 0` reset on stream error (DoS protection fix)
- Replaced `console.warn` with silent behavior in prompt/registry, orchestrator, memory/relay
- Replaced `as unknown as` casts with proper runtime type guards in handoff and spawn
- Made hardcoded limits configurable: `maxRecords` in cost-tracker, `MAX_RECEIPTS`/`MAX_INBOX_PER_AGENT` in handoff, `MAX_VIOLATIONS` in context-boundary

### Wave 2: Adapters (2 files modified, 2 test files updated)
- Added `responseFormat` passthrough (json_object, json_schema) to OpenAI `chat()` and `stream()`
- Added `max_tokens` to OpenAI `stream()` (was missing)
- Added `stream_options: { include_usage: true }` to OpenAI stream
- Fixed empty tool call ID fallback from `''` to `tool_${tc.index}`
- Made OpenAI providers extensible via `registerProvider()`
- Fixed Anthropic to throw `HarnessError` instead of generic `Error`
- Removed unused `maxRetries` from `AnthropicAdapterConfig`
- Added 12 new tests for OpenAI, strengthened 3 Anthropic tests

### Wave 3: Integration Packages (4 files modified, 1 test file updated)
- Redis: Added `sessionId` filtering in `query()`
- Redis: Made `setEntry()` atomic with `client.multi()` pipeline
- Redis: Added input validation for client and TTL
- Redis: Removed `console.warn` from corrupted entry handler
- Langfuse: Fixed `flush()` to not clear trace maps (only `shutdown()` does)
- Langfuse: Made `MAX_TRACE_MAP_SIZE` configurable via `maxTraceMapSize`
- Langfuse: Changed generic `Error` to `HarnessError`
- Langfuse: Made `maxRecords` in cost tracker configurable
- AJV: Fixed format loader to retry on transient failures (reset cached promise)
- OpenTelemetry: Made span limit configurable via `maxSpans`

### Wave 4: Queue + Rate Limiter (2 files modified)
- Added `dequeue()`, `peek()`, `size()` to MessageQueue
- Added `maxQueueSize` validation
- Changed distributed rate limiter from runtime crash to no-op guardrail with reason

### Wave 5: Build Config
- Verified core's dual-config approach is intentional and correct (no changes needed)

### Test Fixes (5 tests updated)
- relay.test.ts: Updated 2 tests to verify silent behavior instead of console.warn
- rate-limiter.test.ts: Updated 1 test to verify no-op guardrail instead of throw
- agent-loop.test.ts: Updated 1 test to verify construction-time validation
- registry.test.ts: Updated 1 test to verify silent overwrite behavior

## Files Modified

| Package | File | Changes |
|---------|------|---------|
| core | src/core/agent-loop.ts | Input validation, stream byte fix |
| core | src/context/compress.ts | Budget validation |
| core | src/guardrails/self-healing.ts | maxRetries validation |
| core | src/guardrails/rate-limiter.ts | Distributed mode no-op |
| core | src/session/manager.ts | Session config validation |
| core | src/observe/trace-manager.ts | maxTraces validation |
| core | src/observe/cost-tracker.ts | Configurable maxRecords |
| core | src/orchestration/handoff.ts | ID validation, configurable limits, type guards |
| core | src/orchestration/orchestrator.ts | Silent error handling |
| core | src/orchestration/message-queue.ts | dequeue/peek/size, validation |
| core | src/orchestration/spawn.ts | Typed config object |
| core | src/orchestration/context-boundary.ts | Configurable maxViolations |
| core | src/prompt/registry.ts | Silent overwrite |
| core | src/memory/relay.ts | Silent corruption handling |
| openai | src/index.ts | responseFormat, maxTokens, stream_options, providers |
| anthropic | src/index.ts | HarnessError, removed maxRetries |
| redis | src/index.ts | sessionId filter, atomic writes, validation |
| langfuse | src/index.ts | Graceful shutdown, configurable limits, HarnessError |
| ajv | src/index.ts | Format loader retry |
| opentelemetry | src/index.ts | Configurable maxSpans |

## Remaining Items (from original 67)

The following items from the audit were NOT addressed in this fix wave as they require new test files rather than code fixes:

- P0-07: Tests for `createHarness()` factory (new test file needed)
- P0-08: Tests for session auth OAuth flows (new test file needed)
- P1-13: CLI module tests (new test file needed)
- P1-14-17: Integration/streaming/concurrent tests (new test files needed)
- P2-04: Agent loop `run()` refactoring (large refactor, separate PR)
- P2-11: Property-based testing (new testing infrastructure)

These are test coverage gaps and architectural refactors that should be addressed in a follow-up PR.
