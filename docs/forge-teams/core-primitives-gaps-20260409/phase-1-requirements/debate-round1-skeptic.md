# Debate Round 1 — Technical Skeptic Responses

**Date**: 2026-04-09
**In response to**: Product Advocate's P0/P1/P2 prioritization

---

## Gap 3: Parallel Tool Execution

**Advocate's position**: P0, 3x speedup, table stakes, opt-in, Promise.allSettled
**My original position**: DEFER
**Updated position**: CONDITIONAL CONCEDE — build it, but with strict guardrails

### What the advocate gets right

I concede the performance argument **for the specific case of independent API-calling tools**. Three external HTTP calls at 2s each is a 6s→2s improvement. That's real. My "3% improvement" estimate was calibrated for fast local tools, not network-bound ones. Fair point.

I also concede that `Promise.allSettled()` addresses my fail-fast semantics concern. It returns all results (successes and failures), which maintains the "LLM sees everything and decides" contract. The error semantics don't change as fundamentally as I claimed.

### What the advocate gets wrong — and this is load-bearing

**The rate limiter is not thread-safe. Full stop.**

Look at `registry.ts:96-110`:

```typescript
async function execute(call: ToolCallRequest): Promise<ToolResult> {
  if (turnCalls >= maxPerTurn) {    // CHECK
    return toolError(...);
  }
  // ...
  turnCalls++;                       // INCREMENT
  sessionCalls++;
```

This is a textbook TOCTOU race. With 5 parallel `execute()` calls and `maxPerTurn = 3`:
- All 5 calls read `turnCalls = 0` → all 5 pass the check
- All 5 increment → `turnCalls = 5` (exceeds limit)
- User configured a limit of 3 and got 5 executions

This isn't theoretical — it's the exact concurrency bug that `Promise.allSettled()` would trigger. The fix is either:
1. An atomic check-and-increment (semaphore pattern)
2. Pre-validation: check `toolCalls.length <= maxPerTurn - turnCalls` before dispatching parallel batch

Neither is hard, but neither is trivial either, and **it must ship with the parallel execution feature or users will hit silent rate limit violations.**

**Conversation message ordering is a real constraint the advocate hasn't addressed.**

The current loop pushes tool results into the conversation array in tool-call order (`agent-loop.ts:263-268`). With `Promise.allSettled()`, results resolve in completion order, not call order. The fix is straightforward (use indexed insertion or pre-allocate slots), but it must be explicit in the design.

**The `parallel: true` config flag is the wrong API.**

"Opt-in parallel" at the loop level means ALL tools in a batch run in parallel. But a single LLM response might contain both a `readFile` tool call and a `writeFile` tool call that writes to the same file. The user can't know in advance which batches are safe to parallelize.

Better API: let individual `ToolDefinition` declare `parallelSafe: boolean` (default `false`). The loop then partitions each batch into parallel-safe and sequential groups. This pushes the decision to tool authors who know their tools' semantics.

### Conditions for concession

I'll move to **BUILD** if:
1. Rate limiter gets a pre-flight check: `if (toolCalls.length > remainingTurnBudget) → sequential fallback`
2. Conversation ordering is preserved (indexed insertion, not push-on-resolve)
3. Per-tool `parallelSafe` flag rather than loop-level `parallel: true`
4. Default remains sequential — parallel is opt-in at the tool definition level

### Revised verdict: BUILD with conditions (was DEFER)

---

## Gap 2: Auto-Compaction Trigger

**Advocate's position**: P0, pure function, no cross-module imports
**My original position**: KILL
**Updated position**: STILL KILL as a "primitive" — CONCEDE as a documented pattern

### The advocate reframed the proposal — let me reframe my attack

The advocate says: "pure function `compactor.compact(messages)` — takes messages in, returns messages out. Module boundaries stay intact."

Let me trace what this function actually needs to do its job:

1. **Count tokens** — needs `countTokens()` from `context/count-tokens.ts`
2. **Compare against threshold** — needs a threshold number (where does it come from?)
3. **Compress messages** — needs `compress()` from `context/compress.ts`

If `compactor.compact(messages)` takes `messages` in and returns `messages` out, then it's literally:

```typescript
function compact(messages: Message[], budget: number, strategy: string): Promise<Message[]> {
  const tokens = countTokens('default', messages);
  if (tokens <= budget) return Promise.resolve([...messages]);
  return compress(messages, { strategy, budget });
}
```

This is `compress()` with a short-circuit. It already exists — `compress()` itself can handle messages that fit within budget (the `summarize` strategy explicitly checks this at `compress.ts:164-166`). The "auto" part is just calling `compress()` conditionally.

**So what is the advocate actually proposing?**

If it's a pure function in the `context` module that wraps `compress()` with a threshold check — fine, but that's a 5-line helper, not a "core primitive" and not a P0 gap. It doesn't need CostTracker. It doesn't cross module boundaries. It's also not meaningfully different from what exists.

If it's something that automatically triggers inside the agent loop — that's the cross-module violation I flagged, and the advocate's "pure function" framing is masking the real proposal.

**The boilerplate complaint deserves a response, but not a primitive.**

I don't dispute that users write this code repeatedly. But the answer isn't a new primitive — it's a recipe in documentation:

```typescript
// Auto-compaction recipe (put this in your loop consumer)
for await (const event of loop.run(messages)) {
  if (event.type === 'message') {
    const tokens = countTokens(model, messages);
    if (tokens > contextWindowSize * 0.8) {
      messages = await compress(messages, {
        strategy: 'sliding-window',
        budget: contextWindowSize * 0.6,
      });
    }
  }
  // ... handle other events
}
```

This is 6 lines. It uses existing primitives. It doesn't violate module boundaries. It gives the user full control over threshold, strategy, and timing. And — critically — the user can see exactly when compaction happens, which matters for debugging.

### The token accuracy problem remains

The advocate didn't address TC-007. The heuristic estimator (`token-estimator.ts:58-78`) uses character ratios. For a compaction trigger, the difference between "80% of context window" and "100% of context window" might be the difference between "compacts gracefully" and "API rejects the request." A 20% error on the heuristic means the trigger fires at 64% or 96% of the actual limit. Neither is correct.

This isn't a reason to kill the concept — it's a reason to not automate it. Users who care about accuracy will register a real tokenizer. Users who don't care about accuracy will use the heuristic and accept the margin. But embedding this into a "primitive" implies precision that doesn't exist.

### Conditions for partial concession

I'll concede to **adding a `compactIfNeeded()` helper to the `context` module** (not a new module, not a cross-module primitive) if:
1. It lives in `context/compress.ts` alongside `compress()` — no new files, no new modules
2. It takes explicit parameters (messages, budget, strategy) — no implicit state
3. It does NOT import from `observe/` or `core/agent-loop.ts`
4. It's documented as a convenience wrapper, not a "core primitive"
5. The documentation includes the 6-line manual pattern for users who want full control

### Revised verdict: KILL as primitive, BUILD as `context` module helper (was KILL)

---

## Gap 4: MCP Client

**Advocate's position**: P2
**My position**: BUILD, agreed on P2

No disagreement on priority. MCP spec is still stabilizing. `@harness-one/mcp` as a separate package with tools-only v0.1 is the right call whenever it ships.

The advocate's P2 rating reflects the reality that MCP adoption is still early and most users don't need it yet. I agree — ship it when the spec stabilizes further and demand crystallizes.

**One addition**: when we do build it, the tool naming strategy needs to be decided upfront. MCP tools from server "github" with tool "create_issue" should register as `github.create_issue` in the ToolRegistry namespace. This avoids collision with locally-registered tools and leverages the existing dot-notation namespace pattern already supported by `list(namespace)` in `registry.ts:80-84`.

### Verdict: BUILD at P2 (unchanged)

---

## Gap 1: Sub-Agent / Nested Loop

**Advocate's position**: Utility function `spawnSubAgent()`, no AgentLoop changes
**My original position**: DEFER
**Updated position**: CONCEDE — the utility function framing solves my concerns

### Why I'm conceding

The advocate's proposal is essentially what I recommended as the alternative:

> "A thin userland wrapper around two independent AgentLoop instances"

A utility function that:
1. Creates a new `AgentLoop` with its own config
2. Runs it with a subset of messages
3. Returns `{ messages, summary, usage }`

This has:
- **Zero blast radius** — no changes to `AgentLoop`, `AgentEvent`, or any existing types
- **No abort tree problem** — the utility function can create a child `AbortController` linked to the parent's signal, and the function's own scope handles cleanup
- **No event bubbling** — the caller consumes the child's events internally and returns a summary
- **No token budget coupling** — the returned `usage` lets the caller decide whether to deduct from a parent budget

This is architecturally sound. It's a factory function (consistent with the project's patterns) that composes existing primitives.

### Remaining conditions

1. It should live in the `orchestration` module (not `core`) — it's coordination logic
2. The `signal` parameter should be required (not optional) to force callers to think about cancellation
3. The return type should be frozen (consistent with project conventions)
4. Document that the child's conversation is fully isolated — no shared mutable state

### Revised verdict: BUILD (was DEFER)

---

## Updated Risk-Ranked Ordering

| Rank | Gap | Risk | Original Verdict | Updated Verdict |
|------|-----|------|-----------------|-----------------|
| 1 | Gap 3: Parallel Tools | High | DEFER | BUILD with conditions |
| 2 | Gap 2: Auto-Compaction | Medium | KILL | Helper in `context` module (not a primitive) |
| 3 | Gap 1: Sub-Agent | Low | DEFER | BUILD as utility function |
| 4 | Gap 4: MCP Client | Low | BUILD (P2) | BUILD (P2, unchanged) |

## Open Challenges Still Requiring Resolution

| ID | Challenge | Gap | Status |
|----|----------|-----|--------|
| TC-011 | Rate limiter TOCTOU race | Gap 3 | **BLOCKING** — must fix before parallel ships |
| TC-012 | Per-tool parallelSafe flag vs loop-level flag | Gap 3 | **BLOCKING** — API design question |
| TC-007 | Token heuristic accuracy for triggers | Gap 2 | Acknowledged — mitigated by making it a helper, not automatic |
| TC-018 | MCP tool namespace collision strategy | Gap 4 | Open — needs decision before build |

## Debate Score

- Challenges issued: 18
- Advocate addressed effectively: 8
- Challenges where I conceded: 6 (Gap 1 blast radius, Gap 3 perf argument, Gap 3 error semantics, Gap 2 "pure function" partial)
- Challenges standing: 4 (TC-011, TC-012, TC-007, TC-018)
- Challenges reinforced with new evidence: 2 (rate limiter TOCTOU, API design for parallelSafe)
