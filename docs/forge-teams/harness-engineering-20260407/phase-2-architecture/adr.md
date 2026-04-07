# ADR: harness-one Architecture

**Version**: 1.0 | **Date**: 2026-04-07 | **Status**: Approved
**Base**: Proposal A (Minimal Composable) + cherry-picks from Proposal B (Production DX)
**Review Score**: 8.35/10

---

## Architecture Overview

```
harness-one (single package, subpath exports)
├── harness-one/core        — AgentLoop class + shared types (Message, AgentEvent, AgentAdapter)
├── harness-one/context     — 5 primitives (countTokens, createBudget, packContext, compress, analyzeCacheStability)
├── harness-one/tools       — defineTool + createRegistry + validateToolCall
├── harness-one/guardrails  — createPipeline + withSelfHealing + 4 reference guardrails
└── (internal) _internal/   — json-schema validator, token estimator
              errors/       — HarnessError hierarchy
```

---

## 1. Directory Structure

```
src/
├── core/
│   ├── index.ts              # Public exports
│   ├── agent-loop.ts         # AgentLoop class (AsyncGenerator-based)
│   ├── types.ts              # Message, Role, ToolCallRequest, TokenUsage, AgentAdapter
│   ├── events.ts             # AgentEvent discriminated union, DoneReason
│   └── errors.ts             # HarnessError, MaxIterationsError, AbortedError
├── context/
│   ├── index.ts              # Public exports
│   ├── types.ts              # Segment, BudgetConfig, ContextLayout, CompressionStrategy, CacheStabilityReport
│   ├── count-tokens.ts       # countTokens(), registerTokenizer()
│   ├── budget.ts             # createBudget() → TokenBudget
│   ├── pack.ts               # packContext()
│   ├── compress.ts           # compress() + built-in strategies
│   └── cache-stability.ts    # analyzeCacheStability()
├── tools/
│   ├── index.ts              # Public exports
│   ├── types.ts              # ToolDefinition, ToolCall, ToolResult, ToolFeedback, ValidationError
│   ├── define-tool.ts        # defineTool()
│   ├── registry.ts           # createRegistry() → ToolRegistry
│   └── validate.ts           # validateToolCall()
├── guardrails/
│   ├── index.ts              # Public exports
│   ├── types.ts              # Guardrail, GuardrailVerdict, PipelineConfig, PipelineResult
│   ├── pipeline.ts           # createPipeline(), runInput(), runOutput()
│   ├── self-healing.ts       # withSelfHealing()
│   ├── rate-limiter.ts       # createRateLimiter()
│   ├── injection-detector.ts # createInjectionDetector()
│   ├── schema-validator.ts   # createSchemaValidator()
│   └── content-filter.ts     # createContentFilter()
└── _internal/
    ├── json-schema.ts        # Minimal JSON Schema validator (~200 lines)
    └── token-estimator.ts    # Character-based token estimation heuristic
```

---

## 2. Module Dependency Graph (Acyclic)

```
┌──────────┐
│ core/    │  ← defines shared types (Message, AgentEvent, AgentAdapter)
│          │     + AgentLoop class + HarnessError hierarchy
└────┬─────┘
     │
     ├─────────────────┬────────────────┐
     │                 │                │
     ▼                 ▼                ▼
┌─────────┐    ┌───────────┐    ┌────────────┐
│context/ │    │  tools/   │    │guardrails/ │
│         │    │           │    │            │
└─────────┘    └───────────┘    └────────────┘
     │                 │                │
     └────────┬────────┘                │
              ▼                         │
        ┌───────────┐                   │
        │ _internal/│ ◄─────────────────┘
        └───────────┘
```

**Rules:**
1. `core/` → `_internal/` only
2. `context/`, `tools/`, `guardrails/` → `core/` (type-only imports for Message, etc.) + `_internal/`
3. `context/`, `tools/`, `guardrails/` → NEVER import each other
4. `_internal/` → nothing (leaf)

---

## 3. Core Types

### 3.1 Shared Types (core/types.ts)

```typescript
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  readonly role: Role;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: ToolCallRequest[];
  readonly meta?: MessageMeta;
}

export interface MessageMeta {
  readonly pinned?: boolean;          // Never compress
  readonly isFailureTrace?: boolean;  // Preserve during compression
  readonly timestamp?: number;        // For age-based compression
  readonly tokens?: number;           // Pre-computed token count
}

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;  // JSON string (matches LLM wire format)
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface AgentAdapter {
  chat(params: ChatParams): Promise<ChatResponse>;
  stream?(params: ChatParams): AsyncIterable<StreamChunk>;
  countTokens?(messages: readonly Message[]): Promise<number>;
}

export interface ChatParams {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly signal?: AbortSignal;
}

export interface ChatResponse {
  readonly message: Message;
  readonly usage: TokenUsage;
}

export interface StreamChunk {
  readonly type: 'text_delta' | 'tool_call_delta' | 'done';
  readonly text?: string;
  readonly toolCall?: Partial<ToolCallRequest>;
  readonly usage?: TokenUsage;
}

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [key: string]: unknown;
}
```

### 3.2 Error Hierarchy (core/errors.ts)
From Proposal B — every error has `.code` and `.suggestion`.

```typescript
export class HarnessError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly suggestion?: string,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}

export class MaxIterationsError extends HarnessError { /* code: MAX_ITERATIONS */ }
export class AbortedError extends HarnessError { /* code: ABORTED */ }
export class GuardrailBlockedError extends HarnessError { /* code: GUARDRAIL_BLOCKED */ }
export class ToolValidationError extends HarnessError { /* code: TOOL_VALIDATION */ }
export class TokenBudgetExceededError extends HarnessError { /* code: TOKEN_BUDGET_EXCEEDED */ }
```

### 3.3 Agent Events (core/events.ts)

```typescript
export type AgentEvent =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; toolCall: ToolCallRequest; iteration: number }
  | { type: 'tool_result'; toolCallId: string; result: unknown }
  | { type: 'message'; message: Message; usage: TokenUsage }
  | { type: 'error'; error: HarnessError }
  | { type: 'done'; reason: DoneReason; totalUsage: TokenUsage };

export type DoneReason = 'end_turn' | 'max_iterations' | 'token_budget' | 'aborted';
```

### 3.4 Agent Loop (core/agent-loop.ts)
From Proposal B — class with `.run()` returning AsyncGenerator. Genuinely stateful (tracks iteration count, cumulative usage, abort flag).

```typescript
export interface AgentLoopConfig {
  readonly adapter: AgentAdapter;
  readonly maxIterations?: number;        // Default: 25
  readonly maxTotalTokens?: number;       // Default: Infinity
  readonly signal?: AbortSignal;
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
}

export class AgentLoop {
  constructor(config: AgentLoopConfig);
  run(messages: Message[]): AsyncGenerator<AgentEvent>;
  abort(): void;
  get usage(): TokenUsage;
}
```

### 3.5 Context Primitives (context/)
From Proposal A — pure functions, no classes. Users compose as needed.

```typescript
// count-tokens.ts
export function countTokens(model: string, messages: readonly Message[]): number;
export function registerTokenizer(model: string, tokenizer: { encode(text: string): { length: number } }): void;

// budget.ts
export interface TokenBudget {
  readonly totalTokens: number;
  remaining(segmentName: string): number;
  allocate(segmentName: string, tokens: number): void;
  reset(segmentName: string): void;
  needsTrimming(): boolean;
  trimOrder(): Array<{ segment: string; trimBy: number; priority: number }>;
}

export function createBudget(config: {
  totalTokens: number;
  segments: Array<{ name: string; maxTokens: number; trimPriority?: number; reserved?: boolean }>;
  responseReserve?: number;
}): TokenBudget;

// pack.ts
export function packContext(layout: {
  head: Message[];
  mid: Message[];
  tail: Message[];
  budget: TokenBudget;
}, model?: string): { messages: Message[]; truncated: boolean; usage: { head: number; mid: number; tail: number } };

// compress.ts
export interface CompressionStrategy {
  readonly name: string;
  compress(messages: readonly Message[], targetTokens: number, options?: {
    preserve?: (msg: Message) => boolean;
    signal?: AbortSignal;
  }): Promise<readonly Message[]>;
}

export function compress(messages: readonly Message[], options: {
  strategy: string | CompressionStrategy;
  budget: number;
  preserve?: (msg: Message) => boolean;
  summarizer?: (messages: Message[]) => Promise<string>;
  windowSize?: number;
}): Promise<Message[]>;

// Built-in strategies: 'truncate', 'sliding-window', 'summarize', 'preserve-failures'

// cache-stability.ts
export function analyzeCacheStability(v1: readonly Message[], v2: readonly Message[], model?: string): {
  prefixMatchRatio: number;
  firstDivergenceIndex: number;
  stablePrefixTokens: number;
  recommendations: string[];
};
```

### 3.6 Tool System (tools/)
Hybrid — `defineTool()` is a function, `createRegistry()` returns an object with methods.

```typescript
// types.ts — ToolResult from Proposal B (richer)
export interface ToolFeedback {
  readonly message: string;
  readonly category: 'validation' | 'permission' | 'not_found' | 'timeout' | 'internal';
  readonly suggestedAction: string;
  readonly retryable: boolean;
}

export type ToolResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: ToolFeedback };

export function toolSuccess<T>(data: T): ToolResult<T>;
export function toolError(message: string, category: string, suggestedAction: string, retryable?: boolean): ToolResult<never>;

// define-tool.ts
export function defineTool<TParams>(def: {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (params: TParams, signal?: AbortSignal) => Promise<ToolResult>;
}): ToolDefinition<TParams>;

// registry.ts
export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(namespace?: string): ToolDefinition[];
  schemas(): ToolSchema[];
  execute(call: ToolCallRequest): Promise<ToolResult>;
  handler(): (call: ToolCallRequest) => Promise<unknown>;  // For AgentLoop.onToolCall
  resetTurn(): void;
}

export function createRegistry(config?: {
  maxCallsPerTurn?: number;
  maxCallsPerSession?: number;
}): ToolRegistry;

// validate.ts
export function validateToolCall(schema: JsonSchema, params: unknown): {
  valid: boolean;
  errors: Array<{ path: string; message: string; suggestion?: string }>;
};
```

### 3.7 Guardrails (guardrails/)
From Proposal A (functions) + Proposal B (3-way verdict).

```typescript
// types.ts
export type GuardrailVerdict =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'modify'; modified: string; reason: string };

export interface GuardrailContext {
  content: string;
  meta?: Record<string, unknown>;
}

// A guardrail is a function (from Proposal A)
export type Guardrail = (ctx: GuardrailContext) => Promise<GuardrailVerdict> | GuardrailVerdict;

// pipeline.ts
export interface GuardrailPipeline {
  readonly _brand: unique symbol;
}

export function createPipeline(config: {
  input?: Guardrail[];
  output?: Guardrail[];
  failClosed?: boolean;  // Default: true
  onEvent?: (event: { guardrail: string; direction: 'input' | 'output'; verdict: GuardrailVerdict; latencyMs: number }) => void;
}): GuardrailPipeline;

export function runInput(pipeline: GuardrailPipeline, ctx: GuardrailContext): Promise<{
  passed: boolean;
  verdict: GuardrailVerdict;
  results: Array<{ guardrail: string; verdict: GuardrailVerdict; latencyMs: number }>;
}>;

export function runOutput(pipeline: GuardrailPipeline, ctx: GuardrailContext): Promise<{
  passed: boolean;
  verdict: GuardrailVerdict;
  results: Array<{ guardrail: string; verdict: GuardrailVerdict; latencyMs: number }>;
}>;

// self-healing.ts
export function withSelfHealing(config: {
  maxRetries?: number;  // Default: 3
  guardrails: Guardrail[];
  buildRetryPrompt: (content: string, failures: Array<{ reason: string }>) => string;
  regenerate: (prompt: string) => Promise<string>;
}, initialContent: string): Promise<{ content: string; attempts: number; passed: boolean }>;

// Reference guardrails (factory functions from Proposal A)
export function createRateLimiter(config: { max: number; windowMs: number; keyFn?: (ctx: GuardrailContext) => string }): Guardrail;
export function createInjectionDetector(config?: { extraPatterns?: RegExp[]; sensitivity?: 'low' | 'medium' | 'high' }): Guardrail;
export function createSchemaValidator(schema: JsonSchema): Guardrail;
export function createContentFilter(config: { blocked?: string[]; blockedPatterns?: RegExp[] }): Guardrail;
```

---

## 4. Package Exports (package.json)

```json
{
  "name": "harness-one",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    "./core": {
      "import": "./dist/core/index.js",
      "require": "./dist/cjs/core/index.cjs",
      "types": "./dist/core/index.d.ts"
    },
    "./context": {
      "import": "./dist/context/index.js",
      "require": "./dist/cjs/context/index.cjs",
      "types": "./dist/context/index.d.ts"
    },
    "./tools": {
      "import": "./dist/tools/index.js",
      "require": "./dist/cjs/tools/index.cjs",
      "types": "./dist/tools/index.d.ts"
    },
    "./guardrails": {
      "import": "./dist/guardrails/index.js",
      "require": "./dist/cjs/guardrails/index.cjs",
      "types": "./dist/guardrails/index.d.ts"
    }
  },
  "files": ["dist"],
  "engines": { "node": ">=18" },
  "sideEffects": false,
  "license": "MIT"
}
```

No root `"."` export — forces explicit subpath imports.

---

## 5. Extension Points

1. **Custom Guardrails** — Implement the `Guardrail` function type
2. **Custom Compression Strategies** — Implement the `CompressionStrategy` interface
3. **Custom Agent Adapters** — Implement the `AgentAdapter` interface
4. **Custom Tokenizers** — Call `registerTokenizer(model, tokenizer)`
5. **Custom Tool Validators** — Pass custom validation logic to `defineTool`

All extension is via function arguments and interface implementation — no plugins, no decorators, no class inheritance.

---

## 6. Error Handling Strategy

| Layer | Pattern | Example |
|-------|---------|---------|
| **Programmer errors** | Throw `HarnessError` | Missing adapter, unknown segment name |
| **Expected failures** | Return data | `ToolResult.success === false`, `GuardrailVerdict.action === 'block'` |
| **Operational errors** | Yield `AgentEvent.error` | LLM timeout, tool crash (Errors as Feedback) |

Every `HarnessError` has `.code` (programmatic) and `.suggestion` (actionable human text).

---

## 7. Testing Strategy

- **vitest** — ESM-native, TypeScript-first, fast
- **Unit tests** for every public function/class — 90%+ branch coverage target
- **No real LLM calls** in CI — mock AgentAdapter
- **Property-based tests** for JSON Schema validation (fast-check)
- **Integration test** — full loop with mock adapter composing all modules

---

## 8. Build & Bundling

- **tsup** — ESM + CJS dual output, .d.ts generation, code splitting
- **Target**: Node 18
- **CI**: typecheck → lint → test → build → test:types

---

## 9. Estimated Effort

| Component | Lines | Days |
|-----------|-------|------|
| _internal/ (json-schema, token-estimator) | ~350 | 1.5 |
| core/ (AgentLoop, types, events, errors) | ~500 | 2.5 |
| context/ (5 primitives) | ~1,200 | 4 |
| tools/ (define, registry, validate) | ~700 | 2.5 |
| guardrails/ (pipeline, self-heal, 4 builtins) | ~900 | 3 |
| Build setup (tsup, vitest, eslint, CI) | — | 1 |
| Tests | ~2,000 | 4 |
| **Total** | **~5,650** | **~18.5 days** |
