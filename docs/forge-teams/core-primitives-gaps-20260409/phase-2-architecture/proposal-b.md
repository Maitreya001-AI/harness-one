# Architecture Design: Proposal B — Extensible Primitives

**Architect**: Architect B  
**PRD Reference**: `docs/forge-teams/core-primitives-gaps-20260409/phase-1-requirements/prd.md`  
**Date**: 2026-04-09  
**Status**: Competing (Round 1)  
**Design Philosophy**: Extensibility & Future-Proofing

---

## Executive Summary

This proposal designs each of the 5 PRD items as **extension points** — clean abstractions whose APIs won't break when future features arrive. The key idea: every behavioral dimension that *might* vary (execution strategy, token counting, concurrency policy) gets a typed interface, with a simple default that covers today's requirements. Users pay zero complexity tax until they need customization. We favor **strategy interfaces** over boolean flags, **rich return types** over minimal ones, and **generic type parameters** where they prevent future breaking changes.

---

## 1. Rate Limiter TOCTOU Fix (P0)

### 1.1 Design

The TOCTOU bug in `registry.ts:96-111` is straightforward: the rate-limit check and the counter increment are separated by async operations (validation, permission check, tool execution). The fix: **pre-claim counters synchronously before any async work, release on failure**.

However, the current rate limiter is hardcoded inside `createRegistry()`. For extensibility, we introduce a `RateLimitPolicy` interface so users can swap in custom policies (e.g., sliding-window, token-bucket) in the future — but the default implementation is the existing simple counter, now made atomic.

#### Type Additions (`tools/types.ts`)

```typescript
/**
 * Rate-limiting policy for tool execution.
 * Implementations must be synchronous for atomicity guarantees in single-threaded JS.
 */
export interface RateLimitPolicy {
  /** Attempt to acquire a permit. Returns true if allowed, false if rate-limited. */
  tryAcquire(): boolean;
  /** Release a previously acquired permit (call on execution failure). */
  release(): void;
  /** Reset turn-scoped counters. */
  resetTurn(): void;
  /** Reset all counters (turn + session). */
  resetSession(): void;
}
```

#### Registry Config Extension (`tools/registry.ts`)

```typescript
export function createRegistry(config?: {
  // ... existing fields ...
  /** Custom rate limit policy. Overrides maxCallsPerTurn/maxCallsPerSession. */
  rateLimitPolicy?: RateLimitPolicy;
}): ToolRegistry;
```

#### Default Implementation (inside `createRegistry`)

```typescript
function createDefaultRateLimitPolicy(
  maxPerTurn: number,
  maxPerSession: number,
): RateLimitPolicy {
  let turnCalls = 0;
  let sessionCalls = 0;

  return {
    tryAcquire(): boolean {
      if (turnCalls >= maxPerTurn || sessionCalls >= maxPerSession) return false;
      // CLAIM synchronously — before any async gap
      turnCalls++;
      sessionCalls++;
      return true;
    },
    release(): void {
      turnCalls = Math.max(0, turnCalls - 1);
      sessionCalls = Math.max(0, sessionCalls - 1);
    },
    resetTurn(): void {
      turnCalls = 0;
    },
    resetSession(): void {
      sessionCalls = 0;
      turnCalls = 0;
    },
  };
}
```

#### Fixed `execute()` Flow

```typescript
async function execute(call: ToolCallRequest): Promise<ToolResult> {
  // Rate limiting — atomic acquire before any async work
  if (!rateLimit.tryAcquire()) {
    return toolError(
      'Rate limit exceeded',
      'validation',
      'Wait for the next turn or reduce tool calls',
    );
  }

  try {
    // Lookup
    const tool = tools.get(call.name);
    if (!tool) {
      rateLimit.release(); // Release on early exit
      return toolError(`Tool "${call.name}" not found`, 'not_found', '...');
    }

    // Parse arguments
    let params: unknown;
    try {
      params = JSON.parse(call.arguments);
    } catch {
      rateLimit.release();
      return toolError('Invalid JSON in tool call arguments', 'validation', '...');
    }

    // Validate
    const validation = customValidator
      ? customValidator.validate(tool.parameters, params)
      : validateToolCall(tool.parameters, params);
    if (!validation.valid) {
      rateLimit.release();
      const messages = validation.errors.map(e => `${e.path}: ${e.message}`).join('; ');
      return toolError(`Validation failed: ${messages}`, 'validation', '...');
    }

    // Permission check
    if (permissions && !permissions.check(call.name, { toolCallId: call.id, params })) {
      rateLimit.release();
      return toolError(`Permission denied for tool "${call.name}"`, 'permission', '...');
    }

    // Execute (with optional timeout) — the async gap is now AFTER the claim
    if (timeoutMs !== undefined) {
      // ... existing timeout logic ...
      return result;
    }
    return await tool.execute(params);
  } catch (err) {
    // Release on unexpected execution failure
    rateLimit.release();
    throw err;
  }
}
```

**Key insight**: We release on *logical* failures (not found, validation, permission) because these don't represent real tool executions. We do NOT release on successful execution or tool-level errors (timeout, internal), because those represent a real call that consumed a rate-limit slot.

### 1.2 Files Changed

| File | Change |
|------|--------|
| `packages/core/src/tools/types.ts` | Add `RateLimitPolicy` interface |
| `packages/core/src/tools/registry.ts` | Extract rate limiter to policy pattern, fix TOCTOU |

### 1.3 Test Strategy

1. **TOCTOU regression**: Launch N concurrent `execute()` calls against a registry with `maxCallsPerTurn: 1`. Assert exactly 1 succeeds.
2. **Release on failure**: Register a tool, call with invalid JSON, verify counter was released (next call succeeds).
3. **Custom policy**: Inject a custom `RateLimitPolicy`, verify it's called instead of default.
4. **Existing behavior**: All existing registry tests pass unchanged.

### 1.4 Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Release logic missed on a code path | Low | High (silent limit bypass) | Comprehensive test coverage for every early-return path |
| Custom policy breaks atomicity | Low | Medium | Document that `tryAcquire` must be synchronous |

### 1.5 Extension Points

- **Custom rate limit policies**: Token-bucket, sliding-window, per-tool limits — all possible by implementing `RateLimitPolicy`
- **Distributed rate limiting**: A future `RateLimitPolicy` could back onto Redis for multi-process coordination
- **The default remains zero-config**: Users who don't pass `rateLimitPolicy` get the fixed simple counter

---

## 2. Parallel Tool Execution (P1)

### 2.1 Design

Rather than a simple `parallel: boolean` flag, we introduce an `ExecutionStrategy` interface. This lets the system evolve to support dependency-aware execution, priority scheduling, or streaming-as-complete without breaking API changes.

#### Type Additions (`core/types.ts`)

```typescript
/** Result of executing a batch of tool calls. */
export interface ToolExecutionResult {
  readonly toolCallId: string;
  readonly result: unknown;
}

/** Strategy for executing a batch of tool calls. */
export interface ExecutionStrategy {
  /**
   * Execute a batch of tool calls. Returns results in the SAME ORDER as input.
   * Must respect the `sequential` flag on individual tool definitions.
   */
  execute(
    calls: readonly ToolCallRequest[],
    handler: (call: ToolCallRequest) => Promise<unknown>,
    options?: {
      /** Tool metadata lookup — strategy can inspect tool properties. */
      getToolMeta?: (name: string) => { sequential?: boolean } | undefined;
      signal?: AbortSignal;
    },
  ): Promise<readonly ToolExecutionResult[]>;
}
```

#### Built-in Strategies (`core/execution-strategies.ts` — new file)

```typescript
/**
 * Sequential execution strategy (current behavior).
 * Executes tool calls one-by-one in order.
 */
export function createSequentialStrategy(): ExecutionStrategy {
  return {
    async execute(calls, handler, _options) {
      const results: ToolExecutionResult[] = [];
      for (const call of calls) {
        let result: unknown;
        try {
          result = await handler(call);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        results.push({ toolCallId: call.id, result });
      }
      return results;
    },
  };
}

/**
 * Parallel execution strategy with concurrency cap.
 *
 * - Tools marked `sequential: true` run after the parallel batch completes
 * - Concurrency capped at `maxConcurrency`
 * - Results returned in original call order regardless of completion order
 * - Uses Promise.allSettled for fault isolation
 */
export function createParallelStrategy(options?: {
  maxConcurrency?: number;
}): ExecutionStrategy {
  const maxConcurrency = options?.maxConcurrency ?? 5;

  return {
    async execute(calls, handler, strategyOptions) {
      const getMeta = strategyOptions?.getToolMeta;
      
      // Partition into parallel and sequential groups, preserving original indices
      const parallelEntries: Array<{ index: number; call: ToolCallRequest }> = [];
      const sequentialEntries: Array<{ index: number; call: ToolCallRequest }> = [];
      
      for (let i = 0; i < calls.length; i++) {
        const meta = getMeta?.(calls[i].name);
        if (meta?.sequential) {
          sequentialEntries.push({ index: i, call: calls[i] });
        } else {
          parallelEntries.push({ index: i, call: calls[i] });
        }
      }

      // Results array — indexed by original position
      const results: ToolExecutionResult[] = new Array(calls.length);

      // Execute parallel group with concurrency cap
      if (parallelEntries.length > 0) {
        const settled = await promiseAllSettledWithConcurrency(
          parallelEntries.map(e => () => handler(e.call)),
          maxConcurrency,
        );

        for (let i = 0; i < parallelEntries.length; i++) {
          const entry = parallelEntries[i];
          const outcome = settled[i];
          results[entry.index] = {
            toolCallId: entry.call.id,
            result: outcome.status === 'fulfilled'
              ? outcome.value
              : { error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) },
          };
        }
      }

      // Execute sequential group in order
      for (const entry of sequentialEntries) {
        let result: unknown;
        try {
          result = await handler(entry.call);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        results[entry.index] = { toolCallId: entry.call.id, result };
      }

      return results;
    },
  };
}

/**
 * Promise.allSettled with concurrency cap.
 * Runs at most `limit` tasks concurrently.
 */
async function promiseAllSettledWithConcurrency<T>(
  factories: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(factories.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < factories.length) {
      const i = nextIndex++;
      try {
        const value = await factories[i]();
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, factories.length) },
    () => runNext(),
  );
  await Promise.all(workers);
  return results;
}
```

#### AgentLoopConfig Extension

```typescript
export interface AgentLoopConfig {
  // ... existing fields ...

  /**
   * Tool execution strategy. Controls how tool call batches are executed.
   * - Default: sequential (current behavior)
   * - Use createParallelStrategy() for concurrent execution
   * - Implement ExecutionStrategy for custom scheduling
   */
  readonly executionStrategy?: ExecutionStrategy;
}
```

**Convenience**: We also add the simple `parallel` / `maxParallelToolCalls` flags from the PRD as syntactic sugar. The constructor maps them to an `ExecutionStrategy`:

```typescript
// In AgentLoop constructor:
if (config.executionStrategy) {
  this.executionStrategy = config.executionStrategy;
} else if (config.parallel) {
  this.executionStrategy = createParallelStrategy({
    maxConcurrency: config.maxParallelToolCalls ?? 5,
  });
} else {
  this.executionStrategy = createSequentialStrategy();
}
```

#### ToolDefinition Extension (`tools/types.ts`)

```typescript
export interface ToolDefinition<TParams = unknown> {
  // ... existing fields ...
  /** Force sequential execution even in parallel mode. Default: false. */
  readonly sequential?: boolean;
}
```

#### AgentLoop `run()` Changes

The tool-call processing loop (lines 237-269) is replaced:

```typescript
// Process tool calls via execution strategy
conversation.push(assistantMsg);

// Yield all tool_call events first (deterministic ordering)
for (const toolCall of toolCalls) {
  yield { type: 'tool_call', toolCall, iteration };
}

// Execute via strategy
const executionResults = await this.executionStrategy.execute(
  toolCalls,
  async (call) => {
    if (this.onToolCall) {
      return this.onToolCall(call);
    }
    return { error: `No onToolCall handler registered for tool "${call.name}"` };
  },
  {
    getToolMeta: (name) => {
      // Lookup tool definition metadata from tools array
      const schema = this.tools?.find(t => t.name === name);
      return schema ? { sequential: (schema as any).sequential } : undefined;
    },
    signal: this.abortController.signal,
  },
);

// Yield all tool_result events in original order (deterministic)
for (const execResult of executionResults) {
  yield { type: 'tool_result', toolCallId: execResult.toolCallId, result: execResult.result };
  this._totalToolCalls++;

  const toolResultMsg: Message = {
    role: 'tool',
    content: typeof execResult.result === 'string'
      ? execResult.result
      : JSON.stringify(execResult.result),
    toolCallId: execResult.toolCallId,
  };
  conversation.push(toolResultMsg);
}
```

### 2.2 Files Changed

| File | Change |
|------|--------|
| `packages/core/src/core/types.ts` | Add `ToolExecutionResult`, `ExecutionStrategy` interfaces |
| `packages/core/src/core/execution-strategies.ts` | **New file**: `createSequentialStrategy()`, `createParallelStrategy()` |
| `packages/core/src/core/agent-loop.ts` | Add `executionStrategy` to config, replace tool execution loop |
| `packages/core/src/tools/types.ts` | Add `sequential?: boolean` to `ToolDefinition` |
| `packages/core/src/core/index.ts` | Re-export strategy factories |

### 2.3 Test Strategy

1. **Sequential (default)**: Existing tests pass. Tool results in call order.
2. **Parallel basic**: 3 async tools (each sleeps 50ms), total time < 100ms (not 150ms).
3. **Mixed mode**: 2 parallel + 1 sequential tool. Sequential runs after parallel batch.
4. **Concurrency cap**: 10 tools with `maxConcurrency: 2`. Assert max 2 concurrent at any time (use a concurrency counter).
5. **Error isolation**: 1 of 3 tools throws. Other 2 succeed. Failed tool returns error result.
6. **Event ordering**: All `tool_call` events before all `tool_result` events. Results in original call order.
7. **Rate limit compliance**: Parallel mode with `maxCallsPerTurn: 2`. Assert 3rd call is rate-limited.
8. **Custom strategy**: Inject a custom `ExecutionStrategy`, verify it's invoked.
9. **Abort propagation**: Abort signal cancels in-flight parallel tools.

### 2.4 Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `Promise.allSettled` swallows errors silently | Low | Medium | Map rejected → error result objects, test explicitly |
| Concurrency cap implementation bug | Medium | Low | Dedicated unit test for `promiseAllSettledWithConcurrency` |
| `getToolMeta` lookup mismatches | Low | Low | Falls back to parallel (safe default) if tool not found |
| Strategy interface too abstract for simple cases | Low | Low | Sugar flags `parallel`/`maxParallelToolCalls` for simple usage |

### 2.5 Extension Points

- **Dependency-aware execution**: A future `ExecutionStrategy` could analyze tool call arguments and build a DAG
- **Priority scheduling**: Strategy could reorder tools by priority or estimated duration
- **Progressive results**: Strategy could yield partial results as tools complete (future `AsyncGenerator` variant)
- **Per-tool concurrency**: Strategy has access to tool metadata, could enforce per-tool limits
- **The simple API stays simple**: `{ parallel: true }` is all most users need

---

## 3. `spawnSubAgent()` Utility (P1)

### 3.1 Design

The PRD calls for a simple utility. Our extensibility angle: return a **rich result type** with event history (not just messages + usage), and accept a generic `hooks` parameter for lifecycle customization.

#### Types (`orchestration/types.ts`)

```typescript
/** Configuration for spawning a sub-agent. */
export interface SpawnSubAgentConfig {
  readonly adapter: AgentAdapter;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly maxIterations?: number;
  readonly maxTotalTokens?: number;
  readonly signal?: AbortSignal;
  readonly streaming?: boolean;
  /** Execution strategy for tool calls within the child loop. */
  readonly executionStrategy?: ExecutionStrategy;
  /** Optional hooks for lifecycle events. */
  readonly hooks?: SpawnHooks;
}

/** Lifecycle hooks for sub-agent execution. */
export interface SpawnHooks {
  /** Called before the child loop starts. */
  onStart?: () => void;
  /** Called with each event from the child loop. Return false to abort. */
  onEvent?: (event: AgentEvent) => boolean | void;
  /** Called when the child loop completes (success or failure). */
  onComplete?: (result: SpawnSubAgentResult) => void;
}

/** Result of a sub-agent execution. */
export interface SpawnSubAgentResult {
  /** The complete conversation history from the child agent. */
  readonly messages: readonly Message[];
  /** Token usage from the child agent. */
  readonly usage: TokenUsage;
  /** All events emitted during child execution (for debugging/observability). */
  readonly events: readonly AgentEvent[];
  /** The reason the child loop terminated. */
  readonly doneReason: DoneReason;
}
```

#### Implementation (`orchestration/spawn.ts` — new file)

```typescript
import { AgentLoop } from '../core/agent-loop.js';
import type { AgentEvent } from '../core/events.js';
import type { DoneReason } from '../core/events.js';
import type { Message, TokenUsage } from '../core/types.js';
import type { SpawnSubAgentConfig, SpawnSubAgentResult } from './types.js';

/**
 * Spawn a sub-agent, run it to completion, and return the result.
 *
 * The child conversation is fully isolated — no shared mutable state.
 * The return value is frozen (Object.freeze).
 *
 * @example
 * ```ts
 * const result = await spawnSubAgent({
 *   adapter,
 *   messages: [{ role: 'user', content: 'Research topic X' }],
 *   maxIterations: 10,
 * });
 * console.log(result.messages); // Child's conversation
 * console.log(result.usage);    // Token usage for budget tracking
 * ```
 */
export async function spawnSubAgent(
  config: SpawnSubAgentConfig,
): Promise<SpawnSubAgentResult> {
  const childMessages: Message[] = [...config.messages];
  const events: AgentEvent[] = [];
  let doneReason: DoneReason = 'end_turn';

  const loop = new AgentLoop({
    adapter: config.adapter,
    tools: config.tools ? [...config.tools] : undefined,
    onToolCall: config.onToolCall,
    maxIterations: config.maxIterations ?? 10,
    maxTotalTokens: config.maxTotalTokens,
    signal: config.signal,
    streaming: config.streaming,
    executionStrategy: config.executionStrategy,
  });

  config.hooks?.onStart?.();

  try {
    for await (const event of loop.run(childMessages)) {
      events.push(event);

      // Allow hook to abort
      if (config.hooks?.onEvent) {
        const shouldContinue = config.hooks.onEvent(event);
        if (shouldContinue === false) {
          loop.abort();
          break;
        }
      }

      if (event.type === 'message') {
        childMessages.push(event.message);
      }
      if (event.type === 'done') {
        doneReason = event.reason;
      }
    }
  } finally {
    loop.dispose();
  }

  const result: SpawnSubAgentResult = Object.freeze({
    messages: Object.freeze([...childMessages]),
    usage: Object.freeze({ ...loop.usage }),
    events: Object.freeze([...events]),
    doneReason,
  });

  config.hooks?.onComplete?.(result);
  return result;
}
```

### 3.2 Files Changed

| File | Change |
|------|--------|
| `packages/core/src/orchestration/types.ts` | Add `SpawnSubAgentConfig`, `SpawnHooks`, `SpawnSubAgentResult` types |
| `packages/core/src/orchestration/spawn.ts` | **New file**: `spawnSubAgent()` implementation |
| `packages/core/src/orchestration/index.ts` | Re-export `spawnSubAgent` and types |

### 3.3 Test Strategy

1. **Basic spawn**: Child runs, returns messages and usage. Result is frozen.
2. **Abort propagation**: Parent signal aborts child. `doneReason` is `'aborted'`.
3. **Tool calls in child**: Child has tools, makes calls, results appear in messages.
4. **Event capture**: `events` array contains all events from child loop.
5. **Hook lifecycle**: `onStart`, `onEvent`, `onComplete` called in correct order.
6. **Hook abort**: `onEvent` returns `false`, child loop stops.
7. **Isolation**: Mutating the config's `messages` after spawn doesn't affect the child.
8. **Token usage**: Verify `usage` matches child's cumulative usage.

### 3.4 Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Memory pressure from storing all events | Low | Medium | Events are typically small; document that large conversations may accumulate |
| Hook throws during onEvent | Medium | Medium | Wrap hook calls in try-catch (let user errors surface via onComplete) |
| Child loop never terminates | Low | High | `maxIterations` default of 10 is the safety valve; `signal` for external abort |

### 3.5 Extension Points

- **Event history**: `events` in the result enables post-hoc analysis, debugging, and replay
- **Lifecycle hooks**: `SpawnHooks` supports monitoring, progress reporting, and early termination without changing the API
- **Execution strategy passthrough**: Child can use parallel execution if configured
- **Future: Checkpointing**: A hook could persist events for checkpoint/resume (no API change needed)
- **Future: Structured output**: `SpawnSubAgentResult` could be extended with a generic `output` field for typed results

---

## 4. `compactIfNeeded()` Helper (P1)

### 4.1 Design

The PRD wants a thin wrapper. Our extensibility angle: accept a **pluggable token counter** so users aren't locked into the heuristic estimator, and use the existing `CompressionStrategy` interface instead of just string names.

#### API Surface (`context/compress.ts`)

```typescript
/** Options for compactIfNeeded. */
export interface CompactOptions {
  /** Total token budget. */
  readonly budget: number;
  /** Trigger compression at this fraction of budget. Default: 0.75. */
  readonly threshold?: number;
  /** Compression strategy — string name or custom CompressionStrategy. */
  readonly strategy: string | CompressionStrategy;
  /** Strategy-specific: window size for 'sliding-window'. */
  readonly windowSize?: number;
  /** Predicate to preserve messages from compression. */
  readonly preserve?: (msg: Message) => boolean;
  /** Required if strategy is 'summarize'. */
  readonly summarizer?: (messages: Message[]) => Promise<string>;
  /**
   * Custom token counter. Default: built-in heuristic estimator.
   * Allows injecting a precise tokenizer (e.g., tiktoken) without
   * coupling this function to a specific tokenizer library.
   */
  readonly countTokens?: (messages: readonly Message[]) => number;
}

/**
 * Compress messages if they exceed a token budget threshold.
 * Returns messages unchanged if under threshold, compressed if over.
 *
 * **Token estimation accuracy**: The built-in heuristic has ~20-40% margin.
 * For production use, register a real tokenizer via `registerTokenizer()`
 * or pass a custom `countTokens` function.
 *
 * @example
 * ```ts
 * // Simple usage — compress if over 75% of 100k budget
 * const result = await compactIfNeeded(messages, {
 *   budget: 100_000,
 *   strategy: 'sliding-window',
 *   windowSize: 20,
 * });
 *
 * // With custom token counter
 * const result = await compactIfNeeded(messages, {
 *   budget: 100_000,
 *   strategy: 'truncate',
 *   countTokens: (msgs) => msgs.reduce((sum, m) => sum + tiktoken.encode(m.content).length, 0),
 * });
 *
 * // Manual 5-line pattern (for full control):
 * // const tokens = countTokens('claude-3', messages);
 * // if (tokens > budget * 0.75) {
 * //   messages = await compress(messages, { strategy: 'sliding-window', budget });
 * // }
 * ```
 */
export async function compactIfNeeded(
  messages: readonly Message[],
  options: CompactOptions,
): Promise<Message[]> {
  const threshold = options.threshold ?? 0.75;
  const triggerAt = options.budget * threshold;

  // Count current tokens
  const currentTokens = options.countTokens
    ? options.countTokens(messages)
    : messages.reduce((sum, msg) => sum + msgTokens(msg), 0);

  // If under threshold, return unchanged (shallow copy for consistency)
  if (currentTokens <= triggerAt) {
    return [...messages];
  }

  // Over threshold — compress
  return compress(messages, {
    strategy: options.strategy,
    budget: options.budget,
    preserve: options.preserve,
    summarizer: options.summarizer,
    windowSize: options.windowSize,
  });
}
```

### 4.2 Files Changed

| File | Change |
|------|--------|
| `packages/core/src/context/compress.ts` | Add `CompactOptions` interface and `compactIfNeeded()` function |
| `packages/core/src/context/index.ts` | Re-export `compactIfNeeded` and `CompactOptions` |

### 4.3 Test Strategy

1. **Under threshold passthrough**: 10 tokens, budget 100, threshold 0.75. Returns messages unchanged.
2. **Over threshold compression**: 80 tokens, budget 100, threshold 0.75. Returns compressed messages.
3. **Custom threshold**: Threshold 0.5 triggers earlier.
4. **Preserve predicate**: System messages preserved through compression.
5. **Custom countTokens**: Inject a mock counter, verify it's used instead of heuristic.
6. **Strategy passthrough**: Both string names and custom `CompressionStrategy` work.
7. **Edge case**: Empty messages array returns empty array.

### 4.4 Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Token estimate inaccuracy triggers unnecessary compression | Medium | Low | Document ~20-40% margin; `countTokens` escape hatch |
| Returning `[...messages]` for under-threshold allocates needlessly | Low | Low | Consistent return type; optimizer will handle this for small arrays |

### 4.5 Extension Points

- **Custom token counter**: `countTokens` parameter decouples from the heuristic estimator
- **Strategy as interface**: Users can pass custom `CompressionStrategy` implementations
- **Future: Adaptive threshold**: A wrapper could adjust threshold based on conversation dynamics
- **Future: Multi-pass compression**: Chain strategies via composition (first sliding-window, then summarize)

---

## 5. MCP Client (P2)

### 5.1 Design

The PRD scopes this to a separate `@harness-one/mcp` package. Our extensibility angle: a **transport abstraction layer** so the client works with stdio, SSE, and any future transport (WebSocket, gRPC) without API changes.

#### Transport Interface (`packages/mcp/src/transport/types.ts`)

```typescript
/** Transport layer for MCP communication. */
export interface MCPTransport {
  /** Send a JSON-RPC request and receive a response. */
  request<T>(method: string, params?: unknown): Promise<T>;
  /** Close the transport and clean up resources. */
  close(): Promise<void>;
  /** Whether the transport is currently connected. */
  readonly connected: boolean;
}

/** Factory for creating transports — decouples creation from usage. */
export interface MCPTransportFactory {
  create(config: MCPTransportConfig): Promise<MCPTransport>;
}

/** Transport configuration — discriminated union by type. */
export type MCPTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> };
```

#### Client Interface (`packages/mcp/src/types.ts`)

```typescript
import type { ToolDefinition } from '@harness-one/core/tools';

/** MCP tool as returned by the server. */
export interface MCPTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** Options for creating an MCP client. */
export interface MCPClientConfig {
  /** Server name — used as namespace prefix for tools. */
  readonly serverName: string;
  /** Transport configuration. */
  readonly transport: MCPTransportConfig;
  /** Custom transport factory (for testing or custom transports). */
  readonly transportFactory?: MCPTransportFactory;
  /** Request timeout in milliseconds. Default: 30_000. */
  readonly requestTimeout?: number;
}

/** MCP client for discovering and executing tools. */
export interface MCPClient {
  /** Discover tools from the MCP server. */
  listTools(): Promise<MCPTool[]>;
  /** Convert an MCP tool to a harness-one ToolDefinition. */
  toToolDefinition(tool: MCPTool): ToolDefinition;
  /** Convert all discovered tools to ToolDefinitions. */
  toToolDefinitions(): Promise<ToolDefinition[]>;
  /** Close the connection and clean up resources. */
  close(): Promise<void>;
  /** Server name used for namespacing. */
  readonly serverName: string;
  /** Whether the client is connected. */
  readonly connected: boolean;
}
```

#### Client Factory (`packages/mcp/src/client.ts`)

```typescript
import type { ToolCallRequest } from '@harness-one/core/core';
import type { ToolDefinition, ToolResult } from '@harness-one/core/tools';
import { toolSuccess, toolError } from '@harness-one/core/tools';
import type { MCPClient, MCPClientConfig, MCPTool } from './types.js';
import type { MCPTransport } from './transport/types.js';
import { createStdioTransport } from './transport/stdio.js';
import { createSSETransport } from './transport/sse.js';

/**
 * Create an MCP client connected to a tool server.
 *
 * @example
 * ```ts
 * const client = await createMCPClient({
 *   serverName: 'my-server',
 *   transport: { type: 'stdio', command: 'npx', args: ['-y', '@mcp/server'] },
 * });
 *
 * const tools = await client.toToolDefinitions();
 * tools.forEach(t => registry.register(t));
 *
 * await client.close();
 * ```
 */
export async function createMCPClient(config: MCPClientConfig): Promise<MCPClient> {
  // Create transport via factory or built-in
  let transport: MCPTransport;
  if (config.transportFactory) {
    transport = await config.transportFactory.create(config.transport);
  } else {
    transport = await createDefaultTransport(config.transport);
  }

  const serverName = config.serverName;
  const timeout = config.requestTimeout ?? 30_000;

  // MCP initialize handshake
  await transport.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'harness-one', version: '0.1.0' },
  });
  await transport.request('notifications/initialized');

  async function listTools(): Promise<MCPTool[]> {
    const response = await transport.request<{ tools: MCPTool[] }>('tools/list');
    return response.tools;
  }

  function toToolDefinition(tool: MCPTool): ToolDefinition {
    const namespacedName = `${serverName}.${tool.name}`;
    return {
      name: namespacedName,
      description: tool.description,
      parameters: tool.inputSchema as any,
      async execute(params: unknown): Promise<ToolResult> {
        try {
          const result = await transport.request<{ content: unknown }>(
            'tools/call',
            { name: tool.name, arguments: params },
          );
          return toolSuccess(result.content);
        } catch (err) {
          return toolError(
            err instanceof Error ? err.message : String(err),
            'internal',
            'Check MCP server logs',
            true,
          );
        }
      },
    };
  }

  async function toToolDefinitions(): Promise<ToolDefinition[]> {
    const tools = await listTools();
    return tools.map(toToolDefinition);
  }

  async function close(): Promise<void> {
    await transport.close();
  }

  return {
    listTools,
    toToolDefinition,
    toToolDefinitions,
    close,
    get serverName() { return serverName; },
    get connected() { return transport.connected; },
  };
}

async function createDefaultTransport(
  config: MCPTransportConfig,
): Promise<MCPTransport> {
  switch (config.type) {
    case 'stdio':
      return createStdioTransport(config);
    case 'sse':
      return createSSETransport(config);
    default:
      throw new Error(`Unsupported transport type: ${(config as any).type}`);
  }
}
```

### 5.2 Files Changed (new package)

| File | Change |
|------|--------|
| `packages/mcp/package.json` | New package config |
| `packages/mcp/tsconfig.json` | TypeScript config |
| `packages/mcp/src/client.ts` | Client factory |
| `packages/mcp/src/types.ts` | Client types |
| `packages/mcp/src/transport/types.ts` | Transport abstraction |
| `packages/mcp/src/transport/stdio.ts` | stdio transport |
| `packages/mcp/src/transport/sse.ts` | SSE transport |
| `packages/mcp/src/mapping.ts` | Schema conversion utilities |
| `packages/mcp/src/index.ts` | Public exports |

### 5.3 Test Strategy

1. **Connection lifecycle**: Create client, verify connected, close, verify disconnected.
2. **Tool discovery**: Mock transport returns tools, `listTools()` maps correctly.
3. **Tool execution**: `toToolDefinition()` produces working `ToolDefinition`. Execute returns `ToolResult`.
4. **Error mapping**: MCP server error → `toolError` with `internal` category.
5. **Namespace**: Tool names prefixed with `serverName.`.
6. **Custom transport**: Inject via `transportFactory`, verify it's used.
7. **Timeout**: Request exceeds timeout, returns error.
8. **Registry integration**: End-to-end test registering MCP tools with `createRegistry()`.

### 5.4 Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| MCP protocol version mismatch | Medium | High | Pin to `2024-11-05`, document version requirement |
| stdio process orphaning | Medium | High | `close()` sends SIGTERM, then SIGKILL after timeout |
| SSE connection drops silently | Medium | Medium | `connected` flag; reconnect logic in future version |
| `@modelcontextprotocol/sdk` peer dep conflicts | Low | Medium | Use `peerDependencies` with wide range |

### 5.5 Extension Points

- **Transport abstraction**: New transport types (WebSocket, gRPC) implement `MCPTransport` — zero client changes
- **Transport factory**: Testing and custom transports injected without modifying source
- **Future: Resources & Prompts**: The `MCPClient` interface can be extended with `listResources()`, `listPrompts()` without breaking existing usage
- **Future: Multi-server orchestration**: Multiple `MCPClient` instances register tools with the same registry, namespaced by `serverName`
- **Future: Dynamic tool change notifications**: Transport can emit events; client can re-discover tools

---

## 6. Architecture Decision Records

### ADR-01: Strategy Pattern for Tool Execution

**Status**: Proposed

**Context**: The PRD proposes a `parallel: boolean` flag. While simple, this creates a binary choice that must be extended with new flags for every execution variant (dependency-aware, priority-based, streaming).

**Decision**: Introduce an `ExecutionStrategy` interface alongside the simple `parallel` flag. The flag is syntactic sugar that maps to a built-in strategy.

**Consequences**:

- **Positive**: Single extension point for all future execution variants. No breaking changes needed.
- **Positive**: Sugar flag means zero additional complexity for simple use cases.
- **Negative**: One extra interface and file (`execution-strategies.ts`).
- **Negative**: `getToolMeta` callback in strategy is slightly awkward (needed because strategies don't own tool definitions).

**Alternatives Considered**:

- **Boolean flag only** (PRD default): Simpler, but requires new flags for each variant. Rejected because the additional abstraction cost is minimal (~30 LOC).
- **Builder pattern**: `new ExecutionBuilder().parallel(5).sequential('fs.*').build()`. Rejected as over-engineered for current needs.

---

### ADR-02: RateLimitPolicy Extraction

**Status**: Proposed

**Context**: The rate limiter is entangled with `createRegistry()` internals. Fixing the TOCTOU bug is an opportunity to extract a clean interface.

**Decision**: Define `RateLimitPolicy` interface. Default implementation is the fixed simple counter. Users can inject custom policies.

**Consequences**:

- **Positive**: Enables token-bucket, sliding-window, distributed rate limiting without touching registry code.
- **Positive**: Default behavior identical to current (minus the bug).
- **Negative**: One additional interface in `tools/types.ts`.

**Alternatives Considered**:

- **Inline fix only**: Just move the increment. Simpler, but misses the opportunity to make rate limiting pluggable. Rejected because the interface cost is ~10 LOC.

---

### ADR-03: Rich SpawnSubAgentResult

**Status**: Proposed

**Context**: The PRD returns `{ messages, usage }`. This is minimal — users wanting to debug, observe, or replay child execution need to wrap the entire spawn themselves.

**Decision**: Return `{ messages, usage, events, doneReason }`. Events capture the full execution trace.

**Consequences**:

- **Positive**: Enables debugging, observability, replay without additional wrappers.
- **Positive**: `doneReason` tells callers *why* the child stopped — important for error handling.
- **Negative**: Storing all events has memory overhead for long-running children.
- **Risk**: Events reference internal objects (HarnessError instances). Freezing mitigates but doesn't eliminate potential leaks.

**Alternatives Considered**:

- **Minimal return** (`{ messages, usage }`): PRD-specified. Simpler, but users inevitably need events. Rejected because the cost of including events is negligible for typical sub-agent lifetimes (10 iterations).
- **Optional event capture**: Only collect if `captureEvents: true`. Rejected as unnecessary complexity — events are lightweight.

---

### ADR-04: Pluggable Token Counter in compactIfNeeded

**Status**: Proposed

**Context**: `compactIfNeeded` uses the built-in heuristic estimator with ~20-40% margin. Production users need precision but shouldn't be forced to use `registerTokenizer()` globally.

**Decision**: Accept optional `countTokens` function parameter. Default: built-in heuristic.

**Consequences**:

- **Positive**: Users inject precise counting per-call without global state mutation.
- **Positive**: Testing is trivial (inject a mock counter).
- **Negative**: Another parameter on an already parameterful function.

**Alternatives Considered**:

- **Always use registered tokenizer**: Relies on global `registerTokenizer()`. Rejected because global mutable state is contrary to harness-one's design philosophy (explicit parameters, no implicit state).
- **Require model name**: `compactIfNeeded(messages, { model: 'claude-3', ... })`. Rejected because it couples the context module to model awareness.

---

### ADR-05: Transport Abstraction for MCP

**Status**: Proposed

**Context**: MCP currently supports stdio and SSE. WebSocket and gRPC are plausible future transports.

**Decision**: Define `MCPTransport` interface. Built-in implementations for stdio and SSE. `MCPTransportFactory` for injection.

**Consequences**:

- **Positive**: New transports don't require client code changes.
- **Positive**: Testing is easy (mock transport).
- **Negative**: Indirection layer between client and protocol. ~20 LOC overhead.

**Alternatives Considered**:

- **Direct SDK usage**: Call `@modelcontextprotocol/sdk` directly. Simpler, but locks into their transport model. Rejected because we want to decouple from the SDK's internal architecture.
- **Adapter per transport**: Separate `createMCPStdioClient()` and `createMCPSSEClient()`. Rejected because it duplicates client logic.

---

## 7. Comprehensive Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| TOCTOU fix introduces release-on-wrong-path bug | Low | High | Exhaustive test for every early-return in execute() |
| ExecutionStrategy abstraction unused by users | Medium | Low | Sugar flags make it invisible; remove if proven unnecessary |
| Event accumulation in spawnSubAgent memory leak | Low | Medium | Default maxIterations: 10 bounds event count |
| compactIfNeeded threshold triggers too early/late | Medium | Low | Configurable threshold + custom countTokens |
| MCP transport orphaned processes | Medium | High | close() with SIGTERM → SIGKILL escalation |
| Added interfaces increase learning curve | Medium | Low | All have sensible defaults; sugar APIs hide complexity |

---

## 8. Migration Path

All changes are **additive and backwards-compatible**:

1. **P0 (Rate limiter)**: Internal fix. Zero API changes for users not passing `rateLimitPolicy`. Ship immediately.
2. **P1 (Parallel execution)**: New config fields (`parallel`, `executionStrategy`). Default is sequential. No migration needed.
3. **P1 (spawnSubAgent)**: New export. No existing code affected.
4. **P1 (compactIfNeeded)**: New export. No existing code affected.
5. **P2 (MCP)**: New package. Zero impact on core.

---

## 9. Estimated Effort

| Component | Effort | Dependencies |
|-----------|--------|--------------|
| P0: Rate limiter TOCTOU + RateLimitPolicy | 0.5 days | None |
| P1: ExecutionStrategy + parallel execution | 1.5 days | P0 |
| P1: spawnSubAgent() + hooks | 1 day | None (parallel with P0/P1) |
| P1: compactIfNeeded() | 0.5 days | None (parallel) |
| P2: MCP client + transports | 3 days | None (separate package) |
| Tests (all items) | 2 days | All items |
| **Total** | **~8.5 days** | |

---

## 10. Design Principles Applied

1. **Open-Closed Principle**: Every behavioral dimension has an interface (ExecutionStrategy, RateLimitPolicy, MCPTransport, CompressionStrategy). Closed for modification, open for extension.
2. **Zero-Cost Abstractions**: Users who don't customize pay nothing — defaults match current behavior exactly.
3. **Errors as Data**: Parallel tool failures return `ToolResult` errors, not thrown exceptions. MCP errors map to `toolError()`.
4. **Immutable Returns**: `spawnSubAgent` result is deeply frozen. All existing freeze conventions maintained.
5. **Module Isolation**: No new cross-module imports. `spawnSubAgent` lives in orchestration. `compactIfNeeded` lives in context. MCP is a separate package.
6. **Explicit Over Implicit**: `countTokens` parameter instead of relying on global tokenizer registration. `executionStrategy` instead of inferring behavior from flags.
7. **Future-Proof APIs**: Rich return types (SpawnSubAgentResult with events), strategy interfaces, and typed hooks prevent breaking changes when features expand.
