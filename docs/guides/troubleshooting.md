# Troubleshooting

Common errors and how to resolve them. All programmer-error paths throw
`HarnessError` with a `.code` (from `HarnessErrorCode`) and a `.suggestion`
hint. Switch on `err.code`:

```ts
import { HarnessError, HarnessErrorCode } from 'harness-one';

try {
  for await (const ev of harness.run(messages)) { /* ... */ }
} catch (err) {
  if (err instanceof HarnessError) {
    console.error(`[${err.code}] ${err.message}`);
    console.error(`fix: ${err.suggestion}`);
  } else {
    throw err;
  }
}
```

## Common error codes

| `err.code` | When | Fix |
|---|---|---|
| `CORE_INVALID_CONFIG` | Construction-time configuration rejected (missing adapter, invalid budget, malformed provider string, NaN/Infinity in pricing, …) | Read `err.message` — it names the offending field. Typical cases: missing `client` / `model` / `provider`, passing `{}` as `langfuse`, passing a non-positive `maxIterations`. |
| `ADAPTER_AUTH` | Provider rejected the API key (401 / "unauthorized" / "api key") | Check `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env var. The adapter does not retry auth failures — they are non-retryable by default. |
| `ADAPTER_RATE_LIMIT` | Provider returned 429 / "rate" / "too many requests" | Retryable by default (in `retryableErrors`). If it exhausts retries, add a `createRateLimiter` guard on input or back off at the application layer. |
| `ADAPTER_UNAVAILABLE` | 502 / 503 / 504 / "bad gateway" / "service unavailable" | Transient upstream failure. Retried by default with exponential backoff. Consider wiring a `createFallbackAdapter` to a secondary provider. |
| `ADAPTER_NETWORK` | `timeout` / `econnrefused` / "fetch" / "network" | **Not** retryable by default — classifier prioritises 5xx over generic network failures. Widen `retryableErrors` to include `ADAPTER_NETWORK` if your upstream is flaky. |
| `ADAPTER_PARSE` | Provider returned unparseable body | Usually a provider outage. Not retryable. File a provider-side bug. |
| `ADAPTER_CIRCUIT_OPEN` | Circuit breaker is OPEN — too many consecutive failures | Breaker will close after its cooldown. To tune: `createAgentLoop({ circuitBreaker: { failureThreshold, cooldownMs } })`. |
| `ADAPTER_PAYLOAD_OVERSIZED` | Stream cumulatively exceeded `maxStreamBytes` or a tool-call arg exceeded `maxToolArgBytes` | Shrink the model output (tighter prompt) or raise the ceiling via `AgentLoopConfig`. |
| `CORE_MAX_ITERATIONS` | Loop hit `maxIterations` without the model choosing `end_turn` | Model is stuck. Raise the ceiling, or add an explicit stop criterion via guardrails / tools. |
| `CORE_TOKEN_BUDGET_EXCEEDED` | Cumulative `inputTokens + outputTokens` crossed `maxTotalTokens` | Expected when you budget-cap; trim the conversation (`pruneConversation`) or raise the ceiling. |
| `CORE_ABORTED` | External `AbortSignal` fired | Expected on user-driven cancellation. Not an error in the usual sense. |
| `TOOL_VALIDATION` | A tool call's arguments failed schema validation | The LLM emitted malformed args. Loosen the schema (e.g., allow extra fields) or tighten the tool description so the model doesn't guess. |
| `TOOL_CAPABILITY_DENIED` | Tool declared a capability not in `allowedCapabilities` | Widen the registry: `createRegistry({ allowedCapabilities: ['readonly', 'network'] })` or use `createPermissiveRegistry()` (dangerous — opts in to all 5). |
| `GUARD_VIOLATION` / `GUARD_BLOCKED` | A guardrail in the pipeline returned `block` | **Non-retryable** (retrying hits the same guard). Inspect the preceding `guardrail_blocked` event for `guardName` + `reason`. |
| `STORE_CORRUPTION` | MemoryStore or ConversationStore read returned shape-invalid data | Something wrote to the store out-of-band. Inspect the raw payload; `reconcileIndex()` can recover from `fs-store` drift. |
| `POOL_TIMEOUT` | `AdmissionController.acquire()` exceeded its timeout | Tenant over-subscribed. Raise `defaultTimeoutMs`, shed load, or raise `maxInflight`. |

Full enum: [`packages/core/src/infra/errors-base.ts`](../../packages/core/src/infra/errors-base.ts).

## Common foot-guns

### "The LLM keeps looping — why isn't it stopping?"
Most likely a tool-loop. Confirm:
- `AgentLoopConfig.maxIterations` is set (default `10`). After hitting it you
  get `CORE_MAX_ITERATIONS`.
- Your tool schema is tight enough that the model doesn't keep retrying with
  reshuffled arguments.
- Guardrails on tool output aren't rewriting results into shapes that the
  model interprets as "try again" (`GUARDRAIL_VIOLATION:<name>` stubs are the
  signal — you'll see them in the `tool_call_result` events).

### "Fallback adapter never recovers to primary"
By design — the breaker advances one-way. See
[`fallback.md`](./fallback.md) for active-health-check and periodic-reset
patterns.

### "Fallback switched but I have no logs"
There is no `adapter_switched` AgentEvent. Wrap each inner adapter to log
via `categorizeAdapterError()`; see
[`examples/observe/error-handling.ts`](../../examples/observe/error-handling.ts).

### "`HarnessErrorCode` values are empty at runtime"
You did `import type { HarnessErrorCode }` — TS drops the enum members at
runtime. Use value import: `import { HarnessErrorCode }`. The custom lint
rule `harness-one/no-type-only-harness-error-code` catches this.

### "Anthropic / OpenAI adapter returned `{}` for tool args"
The model produced unparseable JSON. Default policy is **warn + substitute
`{}`**. Tighten by passing `{ onMalformedToolUse: 'throw' }` to the
adapter factory.

### "I'm getting `ERR_PACKAGE_PATH_NOT_EXPORTED` on `harness-one/<path>`"
The subpath either doesn't exist or is newer than the installed build.
Valid subpaths: see the **Import-path cheatsheet** in the root README.

## Getting a useful stack trace

- Set `createDefaultLogger({ level: 'debug' })` — surfaces adapter-retry
  events, circuit-breaker transitions, silent-fallback classifications.
- Attach a `TraceManager`: every iteration, tool call, and guardrail check
  becomes a span with attributes (`iteration`, `adapter`,
  `conversationLength`, `toolName`, `inputTokens`, `outputTokens`, …).
- For reproducible reports: every `HarnessError` preserves the underlying
  adapter error as `cause`. `console.dir(err, { depth: 5 })` walks the chain.
