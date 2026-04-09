# Risk Assessment Report

**Plan Version**: ADR v1.0 (Post-bakeoff hybrid)  
**Assessed At**: 2026-04-09  
**Assessor**: risk-assessor  
**Overall Risk Level**: MEDIUM

---

## Executive Summary

**Total Risks Identified**: 19
- HIGH: 4
- MEDIUM: 10
- LOW: 5

**Blocking Risks** (must fix before P4): 2
**Advisory Risks** (recommended but not blocking): 17

---

## Per-Deliverable Risk Assessment

### D1: Rate Limiter TOCTOU Fix (P0)

| Risk ID | Dimension | Severity | Description | Evidence | Mitigation |
|---------|-----------|----------|-------------|----------|------------|
| DEP-01 | Dependency | LOW | P1 (Parallel Execution) depends on this fix completing first | PRD: "P1 depends on P0" | Sequence P0 before P1 in task plan; no parallel scheduling |
| TECH-01 | Technical | HIGH | Pre-claim decrement logic must handle all failure paths: not-found, parse, validate, permission. Current code at `registry.ts:96-184` has 4 distinct early-return paths before `execute()` plus a timeout path. Missing any path leaks a slot permanently. | `registry.ts:114-155` shows 4 pre-execute failure returns; lines 158-184 show execute+timeout path | Enumerate all exit paths explicitly. Write a test for each: not-found, bad JSON, validation fail, permission denied, timeout. Verify counter state after each. |
| TECH-02 | Technical | MEDIUM | The `turnCalls++; sessionCalls++;` pre-claim at `registry.ts:158-159` is between the permission check and execute. If `execute()` throws (not returns error), the counter is never decremented. Current code has no try/catch around `tool.execute()`. | `registry.ts:158-184` — no try/catch wrapping `tool.execute(params)` at line 184 | ADR says "do NOT decrement on execute failure" — but the code must still handle thrown exceptions from `execute()` vs returned errors. Add try/catch around execute to convert throws to ToolResult errors while keeping counter claimed. |
| SEC-01 | Security | MEDIUM | Counter overflow: `turnCalls` and `sessionCalls` are plain `number`. In a long-running session, `sessionCalls` could theoretically approach `Number.MAX_SAFE_INTEGER`. Unlikely in practice but the fix should be robust. | `registry.ts:55-56` — `let turnCalls = 0; let sessionCalls = 0;` | Document that `resetSession()` should be called periodically. Not blocking — practical sessions won't reach this. |
| EST-01 | Estimation | LOW | PRD estimates ~15 LOC. Realistic given the change is moving 2 increments + adding try/catch. However, test coverage for concurrent TOCTOU regression requires async test patterns that may add complexity. | PRD: "~15 lines changed in registry.ts" | Budget extra time for the TOCTOU regression test (concurrent calls). Estimate: 15 LOC code + 30 LOC tests. |

**Deliverable Risk Score**: MEDIUM (one HIGH technical risk around exception handling in execute path)

---

### D2: Parallel Tool Execution (P1)

| Risk ID | Dimension | Severity | Description | Evidence | Mitigation |
|---------|-----------|----------|-------------|----------|------------|
| TECH-03 | Technical | HIGH | The `agent-loop.ts:237-269` sequential tool execution loop yields `tool_call` then immediately `tool_result` events for each tool. Parallel execution must change this to batch all `tool_call` events first, then all `tool_result` events. This changes the event ordering contract — any downstream consumer relying on interleaved `tool_call`/`tool_result` pairs will break. | `agent-loop.ts:237-269` — current sequential pattern; `events.ts` AgentEvent union | ADR specifies deterministic event ordering. Document this as a behavioral change when `parallel: true`. Add integration test verifying event order: all tool_calls emitted before any tool_result. |
| TECH-04 | Technical | HIGH | `promiseAllSettledWithConcurrency` worker pool is a new concurrency primitive. Incorrect implementation (e.g., not draining remaining work on early abort, not respecting `AbortSignal`) leads to leaked promises or hung loops. | ADR-02: "B's worker pool correctly drains work with N concurrent workers"; `agent-loop.ts:272-277` abort check after tool calls | Implement worker pool with explicit abort propagation. Each worker must check `signal.aborted` before starting next item. Test: abort mid-execution with 10 queued tools, verify all resolve/reject within timeout. |
| INT-01 | Integration | HIGH | New `ExecutionStrategy` interface in `core/types.ts` + new file `core/execution-strategies.ts` + integration in `agent-loop.ts`. The `isSequentialTool` callback in AgentLoopConfig bridges core↔tools module boundary. If `isSequentialTool` and `ToolDefinition.sequential` get out of sync (user sets one but not the other), behavior is confusing. | ADR-02: sugar flags + `isSequentialTool` callback; `tools/types.ts` has no `sequential` field yet | Document clearly that `isSequentialTool` is the authoritative source when using `ExecutionStrategy` directly, and `sequential` on ToolDefinition is only used via registry sugar. Consider a single source of truth rather than two parallel mechanisms. |
| INT-02 | Integration | MEDIUM | `agent-loop.ts` currently pushes `conversation.push(toolResultMsg)` inside the sequential for-loop (`line 263-268`). Parallel execution must collect all results and push them in original call order. The conversation array is mutable and shared — race conditions if results arrive out of order. | `agent-loop.ts:263-268` — mutable conversation array | Collect parallel results into a temporary array indexed by original position, then push to conversation in order after all settle. Do not mutate conversation during parallel execution. |
| EST-02 | Estimation | MEDIUM | ADR estimates ~80 LOC across 3 files. This includes: new `ExecutionStrategy` interface + types (~20 LOC), `execution-strategies.ts` with worker pool (~40 LOC), agent-loop integration (~20 LOC). The worker pool alone (with abort, concurrency cap, error isolation) is likely 40-60 LOC. Total more likely ~100-120 LOC. | ADR files changed table; PRD: "~80 LOC across 3 files" | Re-estimate to ~120 LOC. Budget 2 days for implementation + testing rather than 1.5. |
| SEC-02 | Security | MEDIUM | With parallel execution, the rate limiter pre-claim must be atomic across concurrent tool calls. If 5 tools are dispatched in parallel and maxPerTurn=5, all 5 must pre-claim before any execute. Current pre-claim in `registry.ts` is not synchronized — two concurrent `execute()` calls could both read `turnCalls=4`, both increment to 5, exceeding the limit. | `registry.ts:98-111` — rate limit check is non-atomic; ADR-01 fixes TOCTOU but only for sequential calls | The P0 TOCTOU fix must be verified under parallel execution. Since JS is single-threaded, the pre-claim (sync increment before first await) should be safe as long as all pre-claims happen before any await. Verify this assumption in the worker pool implementation — pre-claim must happen synchronously before handing off to the async worker. |

**Deliverable Risk Score**: HIGH (3 HIGH risks around concurrency, event ordering, and interface integration)

---

### D3: spawnSubAgent() (P1)

| Risk ID | Dimension | Severity | Description | Evidence | Mitigation |
|---------|-----------|----------|-------------|----------|------------|
| TECH-05 | Technical | MEDIUM | `spawnSubAgent` creates a new `AgentLoop` internally. The child loop's `abort()` must be wired to the parent's `signal`. If the child loop throws during construction or the first iteration, the error must propagate cleanly to the parent — not silently swallowed. | `agent-loop.ts:55-76` — constructor links external signal to internal AbortController | Wrap child loop creation and `.run()` iteration in try/catch. Propagate errors as part of `SpawnSubAgentResult` (e.g., via `doneReason: 'error'`). Test: parent aborts → child receives abort within 1 tick. |
| TECH-06 | Technical | MEDIUM | Message collection from child loop events. ADR says "A correctly captures both `message` and `tool_result` events to reconstruct full conversation." The child's conversation includes assistant messages with tool calls AND tool result messages. Must reconstruct the complete conversation from AgentEvent stream, not just `message` events. | ADR-03: "Missing tool_result events in message collection" was B's bug; `events.ts` — `tool_result` event has `toolCallId` + `result`, `message` event has the assistant Message | Collect messages by: 1) on `message` event → push assistant message, 2) on `tool_result` event → construct tool Message with toolCallId and push. Test: child makes 3 tool calls → result has 7 messages (system + user + 3 assistant-with-toolcall + 3 tool-result... verify exact count). |
| INT-03 | Integration | LOW | New file `orchestration/spawn.ts` needs to import `AgentLoop` from `core/agent-loop.ts`. This creates an orchestration→core import. Currently `orchestration/` only imports from `./types.js` and `../core/errors.js`. | `orchestration/orchestrator.ts:7` imports from `../core/errors.js`; `orchestration/index.ts` — current exports | This import direction (orchestration → core) is acceptable — orchestration is a higher-level module. But verify no circular dependency: core must not import from orchestration. Run a dependency check. |
| EST-03 | Estimation | LOW | PRD estimates ~40 LOC. Realistic — it's essentially: create AgentLoop, iterate events, collect messages, return frozen result. The `doneReason` addition from ADR-03 is 3 LOC. | PRD: "~40 LOC in orchestration/spawn.ts" | Estimate is reasonable. Budget 0.5 days. |

**Deliverable Risk Score**: MEDIUM (two MEDIUM technical risks around error propagation and message collection)

---

### D4: compactIfNeeded() (P1)

| Risk ID | Dimension | Severity | Description | Evidence | Mitigation |
|---------|-----------|----------|-------------|----------|------------|
| TECH-07 | Technical | MEDIUM | The `countTokens` parameter in ADR-04 conflicts with existing `estimateTokens()` usage. `compress.ts` currently uses `estimateTokens('default', msg.content)` via `msgTokens()` helper (line 16-17). `compactIfNeeded` would need to either: (a) use `countTokens` for the threshold check but `estimateTokens` inside `compress()`, or (b) thread `countTokens` through to `compress()`. Inconsistent token counting between threshold check and compression logic could cause oscillation (compact triggers, but compress doesn't remove enough because it counts differently). | `compress.ts:15-17` — `msgTokens` uses `estimateTokens('default', ...)`;  ADR-04: `countTokens` is per-call injection | `compactIfNeeded` should use `countTokens` only for the threshold check ("should I compress?"), then delegate to `compress()` which uses its own `estimateTokens`. Document this clearly: "countTokens controls when compression triggers; the compression strategy uses its own token estimation." Alternatively, thread countTokens into CompressOptions. |
| INT-04 | Integration | LOW | Adding to existing `compress.ts` (249 lines). No new files needed. Clean integration — just a new exported function. | `compress.ts` — 249 lines, 4 strategies | Straightforward. No risk. |
| EST-04 | Estimation | LOW | PRD estimates ~15 LOC. Realistic: threshold check + call compress + return. | PRD: "~15 LOC in context/compress.ts" | Accurate estimate. Budget 0.25 days. |

**Deliverable Risk Score**: LOW (one MEDIUM technical risk around token counting inconsistency)

---

### D5: MCP Client Package (P2)

| Risk ID | Dimension | Severity | Description | Evidence | Mitigation |
|---------|-----------|----------|-------------|----------|------------|
| DEP-02 | Dependency | MEDIUM | `@modelcontextprotocol/sdk` is an external dependency. Version pinning matters — the MCP spec is still evolving (current spec: 2024-11-05). SDK breaking changes could break the client. | ADR-05: "use @modelcontextprotocol/sdk directly"; PRD: peer dependency | Pin to a specific minor version range (e.g., `^1.x`). Add a CI job that tests against latest SDK. Document minimum supported SDK version. |
| TECH-08 | Technical | MEDIUM | stdio transport spawns a child process. Process lifecycle management (spawn, health check, graceful shutdown, zombie prevention) is notoriously tricky. The `close()` method must handle: process already dead, process ignoring SIGTERM, orphaned processes on parent crash. | ADR-05: "Server lifecycle (spawn, connect, close)"; PRD: `command` + `args` config | Use `child_process.spawn` with `{ stdio: ['pipe', 'pipe', 'pipe'] }`. Register `process.on('exit')` handler to kill child. Set a SIGTERM → wait → SIGKILL timeout (5s). Test: close() when process is already dead, close() when process hangs. |
| TECH-09 | Technical | MEDIUM | SSE transport has HTTP connection lifecycle issues: reconnection on network blip, timeout handling, and proper `EventSource` cleanup. Also, SSE is being superseded by Streamable HTTP in MCP spec evolution. | PRD: "SSE/HTTP transport" in scope | Implement with standard `EventSource` or `fetch` with SSE parsing. Add connection timeout. Consider making transport pluggable from day 1 so Streamable HTTP can be added later without breaking changes. |
| SEC-03 | Security | MEDIUM | MCP `tools/call` executes arbitrary tool calls on an external server. The tool result is fed back into the LLM conversation. A malicious MCP server could return prompt injection payloads in tool results. | PRD: `toToolDefinition()` mapping; tool results flow into conversation via registry handler | Sanitize or tag MCP tool results as "external" in metadata. Document the trust boundary clearly: "MCP servers are trusted to the same degree as any tool execution." Consider adding a content length limit on tool results. |
| SEC-04 | Security | MEDIUM | stdio transport: `command` and `args` from config are passed to `child_process.spawn`. If config comes from untrusted input (e.g., user-provided MCP server config), this is command injection. | PRD: `command: 'npx', args: ['-y', '@mcp/server']` | Document that `createMCPClient` config must come from trusted sources. Do not interpolate user input into command/args. Validate command against an allowlist if config is dynamic. |
| EST-05 | Estimation | MEDIUM | PRD estimates ~400 LOC for new package. This must include: package scaffolding (package.json, tsconfig, etc.), client factory, 2 transport implementations, schema mapping, error handling, tests. 400 LOC for the source is tight — transports alone could be 200 LOC. | PRD: "~400 LOC new package" | Re-estimate to 500-600 LOC source + 300 LOC tests. Budget 3 days (vs implied 2-2.5 from PRD). The package scaffolding (build config, exports) adds overhead not counted in LOC. |

**Deliverable Risk Score**: MEDIUM (clustered MEDIUM risks across dependency, technical, and security dimensions)

---

## Cross-Cutting Risks

### CCR-01: Parallel Execution + Rate Limiter Atomicity

**Dimension**: Technical / Security  
**Severity**: HIGH  
**Affected Tasks**: D1 (Rate Limiter), D2 (Parallel Execution)  
**Description**: The entire parallel execution feature depends on the rate limiter being correct under concurrency. While JavaScript is single-threaded (so synchronous pre-claim is atomic), the worker pool introduces `await` boundaries. If the worker pool's `handler` callback calls `registry.execute()`, and the pre-claim happens inside `execute()` before the first `await`, then N concurrent workers will each synchronously pre-claim before any starts async work. This is correct — BUT only if the execution strategy calls `handler(call)` for all calls synchronously before any `await`. If the worker pool `await`s each `handler()` call individually (which it must, to respect concurrency cap), then pre-claims are interleaved with executions and the ordering is safe. Must verify this specific execution model.  
**Evidence**: `registry.ts:96-159` — pre-claim is synchronous before first await at line 160/184; ADR-02 worker pool design  
**Mitigation**: Write a specific integration test: set `maxPerTurn=3`, dispatch 5 parallel tools. Verify exactly 3 execute, 2 are rate-limited. Test must use real async delays to expose timing issues.

### CCR-02: Type System Coherence Across New Interfaces

**Dimension**: Integration  
**Severity**: MEDIUM  
**Affected Tasks**: D2, D3, D4  
**Description**: Three deliverables add new types: `ExecutionStrategy` + `ToolExecutionResult` (D2), `SpawnSubAgentResult` + `DoneReason` (D3), `CompactOptions` + `countTokens` (D4). These types are spread across `core/types.ts`, `orchestration/types.ts`, and `context/compress.ts`. Must ensure no circular imports and consistent patterns (readonly, frozen results, etc.).  
**Evidence**: ADR files changed table shows type additions in 3 different modules  
**Mitigation**: Review all new type definitions for consistency: all use `readonly` fields, all result types are frozen, naming follows existing conventions (e.g., `*Options` for config, `*Result` for return).

### CCR-03: Event Contract Evolution

**Dimension**: Integration  
**Severity**: MEDIUM  
**Affected Tasks**: D2, D3  
**Description**: Both parallel execution (D2) and spawnSubAgent (D3) interact with the `AgentEvent` stream. D2 changes event ordering; D3 consumes events to reconstruct messages. If D2's event changes aren't reflected in D3's event consumption logic, spawnSubAgent will produce incorrect results in parallel mode.  
**Evidence**: `events.ts:23-32` — current event types; ADR-02 parallel event ordering; ADR-03 message collection  
**Mitigation**: D3 should consume events by type (not by assumed ordering). Test spawnSubAgent with a child loop that uses `parallel: true`.

---

## Risk Heatmap

| Deliverable | Dependency | Estimation | Integration | Technical | Security | Overall |
|-------------|-----------|------------|-------------|-----------|----------|---------|
| D1: Rate Limiter Fix | LOW | LOW | -- | HIGH | MEDIUM | MEDIUM |
| D2: Parallel Execution | LOW | MEDIUM | HIGH | HIGH | MEDIUM | **HIGH** |
| D3: spawnSubAgent | LOW | LOW | LOW | MEDIUM | -- | MEDIUM |
| D4: compactIfNeeded | -- | LOW | LOW | MEDIUM | -- | LOW |
| D5: MCP Client | MEDIUM | MEDIUM | -- | MEDIUM | MEDIUM | MEDIUM |

---

## Recommendations

### Blocking (P4 should not start unless resolved)

1. **[TECH-02] Exception handling in rate limiter execute path**: The current code has no try/catch around `tool.execute()` at `registry.ts:184`. If `execute()` throws (rather than returning a ToolResult), the pre-claimed counter slot is never released AND the error propagation is unclear. The P0 fix MUST wrap the execute call in try/catch to convert thrown exceptions to error ToolResults while keeping the counter claimed (per ADR-01 "do not decrement on execute failure").

2. **[TECH-03 + TECH-04] Parallel execution event ordering and worker pool correctness**: The worker pool is a new concurrency primitive that must be implemented and tested with extreme care. The event ordering change (batched tool_calls then tool_results) is a behavioral contract change. Both must have comprehensive tests before parallel execution ships. Recommend: implement worker pool as a standalone tested utility before integrating into agent-loop.

### Strongly Recommended

3. **[INT-01] Single source of truth for sequential tool marking**: `isSequentialTool` callback and `ToolDefinition.sequential` are two mechanisms for the same thing. Document explicitly which takes precedence, or better, have the registry's `handler()` automatically use `sequential` from the definition so `isSequentialTool` is only needed for non-registry usage.

4. **[SEC-02] Rate limiter under parallel load test**: Write an integration test with `maxPerTurn=3` and 5 parallel tool calls to verify the pre-claim pattern works correctly when multiple calls enter `execute()` concurrently.

5. **[TECH-07] Token counting consistency in compactIfNeeded**: Decide up front whether `countTokens` parameter applies only to the threshold check or also threads through to the compression strategy. Document the decision.

6. **[SEC-03 + SEC-04] MCP security boundaries**: Document trust model for MCP servers. Validate command inputs for stdio transport. Add content length limits on tool results.

7. **[EST-02 + EST-05] Re-estimate D2 and D5**: Parallel execution is ~120 LOC (not 80), MCP client is ~500-600 LOC (not 400). Adjust timeline from 6.5 days to ~8 days total.

### Advisory

8. **[DEP-02] Pin @modelcontextprotocol/sdk version**: MCP spec is evolving. Pin to tested version.
9. **[CCR-02] Type consistency review**: Run a final type consistency pass across all new interfaces before merging.
10. **[CCR-03] Test spawnSubAgent with parallel child**: Ensure event consumption is order-independent.

---

## Verdict

**Plan Status**: APPROVED WITH CONDITIONS

**Conditions**:
1. **TECH-02 must be addressed in the P0 implementation**: Add try/catch around `tool.execute()` in the rate limiter fix. This is a correctness issue in the bug fix itself.
2. **Worker pool (TECH-04) must be implemented as a standalone tested module before agent-loop integration**: This reduces the blast radius of concurrency bugs.
3. **LOC estimates should be revised upward** for D2 (~120 LOC) and D5 (~500-600 LOC) to set realistic expectations. Total estimate: ~8 days instead of 6.5 days.

The plan is fundamentally sound. The hybrid approach from the ADR makes good architectural choices. The risks are concentrated in D2 (Parallel Execution) which is inherently the most complex deliverable. With the conditions above addressed, the plan is ready for P4 parallel implementation.
