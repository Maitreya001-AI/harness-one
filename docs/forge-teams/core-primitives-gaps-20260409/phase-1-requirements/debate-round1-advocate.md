# Debate Round 1: Product Advocate Responses

**Date**: 2026-04-09
**Responding to**: Technical Skeptic Challenges (18 total, 7 critical addressed here)
**PRD Version**: 1.0 → 1.1 (revised based on accepted challenges)

---

## Gap 2: Auto-Compaction — REVISED FROM P0 TO WITHDRAWN FROM CORE

### TC-006: Cross-module boundary violation

**Verdict: ACCEPTED**

The skeptic is right. I verified: there are **zero cross-module imports** across all 11 modules. Every single import (32 total across non-test files) goes to `../core/` or `../_internal/`. 100% compliance.

`createAutoCompactor()` as I proposed would need to:
- Import from `context/` (compression strategies)
- Import from `observe/` (cost tracker alerts) or `_internal/` (token estimation)
- Hook into `core/` (AgentLoop iteration lifecycle)

This would be the **first** cross-module import in the entire codebase. That's not a small thing — it's breaking an architectural invariant that has held across 10 modules and ~30 source files. The invariant isn't accidental; it's what makes modules independently testable, independently versionable, and independently replaceable.

I was wrong to propose this as a core primitive.

### TC-009: Achievable in 5 lines of userland code

**Verdict: ACCEPTED**

The skeptic is correct that the basic pattern is trivial in userland:

```typescript
// User's code — no framework changes needed
for await (const event of loop.run(messages)) {
  if (event.type === 'iteration_start') {
    const tokens = estimateTokens('default', JSON.stringify(messages));
    if (tokens > threshold) {
      messages = await compress(messages, { strategy: 'sliding-window', budget: target });
    }
  }
  // ... handle other events
}
```

This uses only existing public APIs (`estimateTokens`, `compress`) with zero new abstractions. The "glue" I wanted to build is literally 5 lines of application code.

When users can solve a problem in 5 lines with existing primitives, the framework shouldn't absorb that into a new abstraction. That's premature framework-ification.

### TC-010: Precedent erosion of module isolation

**Verdict: ACCEPTED**

This is the strongest argument. Even if we found a way to implement auto-compaction without cross-module imports (e.g., put it in `_internal/`), it would signal that convenience features justify eroding the module boundary. Future contributors would cite this precedent. The architectural moat — "modules depend only on core and _internal, never on each other" — is more valuable than any single convenience feature.

### Skeptic's Counter-Proposal: `compactIfNeeded()` in `context/compress.ts`

**Verdict: ACCEPTED — this is the right middle ground**

The skeptic proposes a thin helper inside the existing `context/compress.ts` module rather than a new cross-module primitive. This works because:

1. **No new module boundary crossed** — `compactIfNeeded()` lives in `context/`, uses only `compress()` and `estimateTokens()` (already imported from `_internal/`), and returns `Message[]`. Zero new imports.
2. **Slightly more than a recipe, less than an abstraction** — it encapsulates the threshold-check-then-compress pattern without creating a new concept. Users call it; they don't configure it.
3. **Pure function** — no state, no lifecycle, no integration with AgentLoop. Just: "given messages and a threshold, compress if needed."

Proposed signature (aligned with skeptic's proposal):
```typescript
// In context/compress.ts
export async function compactIfNeeded(
  messages: readonly Message[],
  options: CompressOptions & { threshold: number },
): Promise<Message[]> {
  const currentTokens = estimateTokens('default', messages.map(m => m.content).join(''));
  if (currentTokens <= options.threshold) return [...messages];
  return compress(messages, options);
}
```

This gives users a one-liner instead of five lines, stays within module boundaries, and doesn't set any precedent.

### Revised Recommendation for Gap 2

**KILL `createAutoCompactor()`. ACCEPT `compactIfNeeded()` helper in `context/compress.ts`.**

- Add `compactIfNeeded()` as a thin pure-function helper (no new module, no new concept)
- Add a "Recipes" section to docs showing integration with AgentLoop event loop
- Optionally, `harness-one-full` can offer richer auto-compaction if demand emerges

**PRD Impact**: Gap 2 reduced from "new primitive" to "helper function in existing module."

---

## Gap 3: Parallel Tools — REVISED FROM P0 TO P1 WITH FIXES

### TC-011: Rate limiter TOCTOU race condition

**Verdict: ACCEPTED — but fixable, not fatal**

I verified the code. The rate limiter in `registry.ts` uses plain `let turnCalls = 0` with non-atomic check-then-increment:

```typescript
// Line 98-111: check
if (turnCalls >= maxPerTurn) { return error; }
// ... validation, permission checks, JSON parsing ...
// Line 158-159: increment (after async gap)
turnCalls++;
sessionCalls++;
```

Under `Promise.all()`, two concurrent `execute()` calls can both pass the check at `turnCalls = 0`, then both increment to 1 — allowing N calls when the limit is N-1.

**However, this is fixable** with a simple pre-claim pattern:

```typescript
// Fix: atomic claim before async work
function execute(call) {
  if (turnCalls >= maxPerTurn) return error;
  turnCalls++;  // Claim slot BEFORE any async operation
  sessionCalls++;
  try {
    // ... validation, execution ...
  } catch {
    turnCalls--;  // Release on failure
    sessionCalls--;
  }
}
```

JavaScript is single-threaded for synchronous code. Moving the increment before the first `await` eliminates the TOCTOU window entirely. No mutex, no Atomics, no complexity.

**This is a bug fix to the registry, not a reason to reject parallelism.** The rate limiter should be safe under concurrency regardless of whether the framework uses it — users could call `registry.execute()` concurrently today in their own code.

### TC-012: Tool ordering dependencies / Skeptic proposes per-tool `parallelSafe: boolean`

**Verdict: DISPUTED — loop-level `parallel: true` is correct; per-tool flag is wrong**

The skeptic proposes adding `parallelSafe: boolean` to `ToolDefinition` so each tool declares whether it's safe to run concurrently. This sounds principled but fails in practice:

**1. It inverts responsibility.** The LLM decides which tools to call in parallel, not the framework. When Claude returns 3 tool calls in a single response, it has already determined they're independent. Adding a per-tool flag means the framework second-guesses the LLM — and gets it wrong, because parallelism safety depends on the *combination* of calls, not individual tools.

Example: `read_file` is always safe to parallelize with itself. But is it safe to parallelize with `write_file`? Depends on whether they target the same file. A per-tool boolean can't express this — you'd need a dependency graph, which is exactly the complexity we agreed to avoid.

**2. It creates a false sense of safety.** Tool authors will default to `parallelSafe: false` (the safe choice), which means parallelism is effectively disabled for most tools. The feature ships but nobody gets the benefit.

**3. No other framework does this.** LangChain, Vercel AI SDK, Anthropic SDK, OpenAI SDK — all execute LLM-returned parallel tool calls concurrently without per-tool opt-in. This is the established contract: if the LLM emits parallel calls, the runtime executes them in parallel.

**4. The escape hatch already exists.** Users who need sequential execution set `parallel: false` (the default). This is a loop-level concern, not a tool-level concern.

**Counter-proposal**: Keep loop-level `parallel: true` as the opt-in. If a specific tool is truly unsafe under concurrency (e.g., it mutates shared process state), the tool author should handle that internally with a lock — that's the tool's responsibility, not the framework's.

**No change to recommendation.** `parallel: true` on AgentLoopConfig, default `false`.

### TC-014: No benchmark proving sequential is a bottleneck

**Verdict: MITIGATED — the skeptic's latency model is incomplete**

The skeptic argues that LLM calls (1-10s) dominate, making tool execution (~100ms) irrelevant. This is true for **in-memory tools** but wrong for the tools that matter most:

| Tool Type | Typical Latency | Parallelizable? |
|-----------|----------------|-----------------|
| In-memory computation | 1-10ms | Doesn't matter |
| Local file I/O | 10-50ms | Marginal benefit |
| Database query | 50-500ms | Yes, significant |
| HTTP API call | 200ms-5s | Yes, very significant |
| Web search | 500ms-3s | Yes, very significant |
| Code execution (sandbox) | 500ms-10s | Yes, very significant |

Real-world agent tool calls are overwhelmingly I/O-bound. A research agent calling 3 web search APIs at 1s each: sequential = 3s, parallel = 1s. A data agent querying 4 database tables at 300ms each: sequential = 1.2s, parallel = 300ms.

**However**, the skeptic is right that I didn't provide benchmarks. I should not have claimed P0 without empirical evidence.

### Revised Recommendation for Gap 3

**Downgrade from P0 to P1. Ship with the TOCTOU fix.**

Changes from original proposal:
1. **Fix rate limiter first** — pre-claim pattern eliminates TOCTOU (independent of parallel feature)
2. **Opt-in only** — `parallel: true` in AgentLoopConfig, default `false`
3. **Batch events** — collect all tool_call/tool_result events, yield them in deterministic order after all tools complete (addresses event ordering concern)
4. **Concurrency cap** — `maxParallelToolCalls` defaults to 5 (prevents resource exhaustion)

The rate limiter fix should ship regardless — it's a correctness issue even without parallel execution if users call `registry.execute()` concurrently in their own code.

---

## Gap 1: Sub-Agent — CONVERGENCE REACHED (BUILD as utility function)

### TC-001/TC-002: Skeptic CONCEDED — agrees `spawnSubAgent()` adds value

The skeptic fully conceded on Gap 1, agreeing that while orchestrator + ContextRelay provide the raw capability, a `spawnSubAgent()` utility function is justified because:

1. The orchestrator requires ~15 lines of boilerplate for the most common use case ("spawn, run, collect summary")
2. A utility function doesn't violate module boundaries — it composes existing primitives
3. It lives in `orchestration/` module, importing only from `core/` (AgentLoop, types)

**Verdict: AGREEMENT — build `spawnSubAgent()` as a utility function in `orchestration/`**

### Agreed API Shape

```typescript
// In orchestration/ module
import { AgentLoop } from '../core/agent-loop.js';
import type { AgentAdapter, Message, TokenUsage } from '../core/types.js';

export interface SpawnSubAgentConfig {
  readonly adapter: AgentAdapter;
  readonly messages: Message[];
  readonly tools?: ToolSchema[];
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly maxIterations?: number;    // Default: 10
  readonly maxTotalTokens?: number;
  readonly signal?: AbortSignal;      // Cascade abort from parent
}

export interface SubAgentResult {
  readonly messages: Message[];       // Full child conversation
  readonly lastMessage: Message;      // Final assistant message (the "summary")
  readonly usage: TokenUsage;         // Total tokens consumed
}

export async function spawnSubAgent(
  config: SpawnSubAgentConfig,
): Promise<SubAgentResult>
```

**Key design decisions**:
- Pure function, not a method on AgentLoop (factory-function philosophy)
- Returns the full conversation + last message (user extracts what they need)
- No implicit context sharing (parent passes what it wants; child returns what it produces)
- AbortSignal cascading for parent→child lifecycle management
- Lives in `orchestration/` — only imports from `core/`, respects module boundaries

### Priority

**P1** — ship in v1. Low complexity, high ergonomic value, zero architectural risk.

**PRD Impact**: Gap 1 restored to P1 as utility function (not the original "new primitive" proposal).

---

## Revised Priority Ranking (Post-Debate, Updated with Skeptic Concessions)

| Rank | Gap | Original | Revised | Rationale |
|------|-----|----------|---------|-----------|
| 1 | **Gap 3: Parallel Tools** | P0 | **P1** | High value. Rate limiter TOCTOU fix is prerequisite (P0 bug fix). Loop-level `parallel: true`, NOT per-tool flag. |
| 2 | **Gap 1: Sub-Agent** | P1 | **P1** | Skeptic conceded. `spawnSubAgent()` utility function in `orchestration/`. Low effort, high ergonomic value. |
| 3 | **Gap 2: Auto-Compaction** | P0 | **Helper only** | `compactIfNeeded()` helper in `context/compress.ts`. No new module, no new concept. |
| 4 | **Gap 4: MCP Client** | P2 | **P2** (unchanged) | Separate package, no core impact. Not challenged. |

### What Actually Ships in Core for v1

1. **Rate limiter TOCTOU fix** (P0 bug fix — pre-claim pattern, independent of parallel feature)
2. **Parallel tool execution** (P1, loop-level opt-in `parallel: true`, default `false`, event batching, concurrency cap)
3. **`spawnSubAgent()` utility** (P1, in `orchestration/`, pure function composing AgentLoop)
4. **`compactIfNeeded()` helper** (P1, in `context/compress.ts`, thin wrapper around existing `compress()`)
5. **MCP client** (P2, separate `@harness-one/mcp` package)
6. **Documentation recipes** for advanced compaction and orchestration patterns

### Key Concession

The skeptic fundamentally changed my thinking on **module isolation as an architectural invariant**. I was treating convenience as a value that could override architecture. The correct framing is: if the architecture says "no cross-module imports," then any feature that requires cross-module imports needs to live outside core — in `harness-one-full`, in userland recipes, or in a separate package. The architecture is the product.

### Key Dispute

I reject the per-tool `parallelSafe: boolean` proposal. Parallelism safety is a property of the *combination* of calls in a given turn, not of individual tools. The LLM determines which calls are independent; the framework executes them. This is industry-standard behavior. Loop-level `parallel: true` is the correct abstraction.

---

## Scorecard

| Challenge | Verdict | Impact on PRD |
|-----------|---------|---------------|
| TC-006 (cross-module boundary) | **ACCEPTED** | Gap 2 reduced from new primitive to helper in existing module |
| TC-009 (5-line userland) | **ACCEPTED** | Gap 2 reduced; `compactIfNeeded()` accepted as middle ground |
| TC-010 (precedent erosion) | **ACCEPTED** | No new modules or cross-module imports |
| TC-011 (TOCTOU race) | **ACCEPTED + FIX** | Rate limiter fix added as P0; Gap 3 downgraded to P1 |
| TC-012 (per-tool `parallelSafe`) | **DISPUTED** | Loop-level `parallel: true` retained; per-tool flag rejected |
| TC-014 (no benchmark) | **MITIGATED** | Gap 3 downgraded from P0 to P1; I/O-bound tools justify parallelism |
| TC-001/TC-002 (orchestrator exists) | **CONVERGENCE** | Skeptic conceded; `spawnSubAgent()` as utility function agreed |

**Challenges accepted**: 4/7
**Challenges disputed**: 1/7 (TC-012 per-tool flag)
**Challenges mitigated**: 1/7
**Converged**: 1/7 (TC-001/TC-002 — both sides moved)
