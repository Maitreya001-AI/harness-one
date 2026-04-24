# ADR-0001 · Use an explicit loop, not a graph DSL

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: harness-one maintainers

## Context

Several agent frameworks (LangGraph, Haystack pipelines, OpenAI's
Swarm-style examples) model the agent as a directed graph of nodes
with declarative edges. The framework owns the scheduler; user code
fills node bodies.

`harness-one` was specifically built to be _the harness around a model_,
not a workflow engine. We need to support arbitrary tool sequences,
mid-iteration cancellation, streaming partial output, hook-driven
instrumentation, and a debugging story that lets a user set a single
breakpoint and see the next LLM call. Every one of those is harder
when the user no longer owns the call site.

## Decision

> **We will run the agent as an explicit `async function*` loop that
> yields events on every iteration, not as a graph DSL.**

`AgentLoop.run()` is a plain `AsyncGenerator<AgentEvent>`. It calls the
adapter, runs guardrails, dispatches tool calls, and emits events in
order. Extension points are exposed as **hooks** (`onIterationStart`,
`onToolCall`, `onTokenUsage`, `onIterationEnd`) and **middleware** —
not nodes. Multi-agent orchestration is built one layer up
(`createOrchestrator`, `createHandoff`, `createMessageQueue`) on top
of the same primitive, so the graph case is reachable when needed but
is never the default.

## Alternatives considered

- **LangGraph-style `StateGraph`** — declarative nodes + conditional
  edges. Rejected: the control flow becomes a data structure that has
  to be inspected to understand what happens next; stack traces from
  inside a node lose the calling edge; and we couldn't find a clean
  way to expose mid-iteration streaming through a graph reducer.
- **Pipeline DSL** (Haystack-style) — sequential `Stage` objects with
  typed inputs/outputs. Rejected: agents are not pipelines; the same
  iteration may take a different shape based on whether the model
  returned a tool call or `end_turn`. Forcing it into a pipeline shape
  created branchy stage definitions that were harder to read than the
  loop they replaced.
- **Build the loop inline at every call site** — no harness at all.
  Rejected: token accounting, guardrails, retry, trace spans, and the
  five terminal exits (`end_turn`, abort, max_iterations, token_budget,
  error) are non-trivial cross-cutting concerns that every consumer
  ended up reimplementing.

## Consequences

### Positive

- Stack traces traverse the loop directly. A breakpoint inside
  `iteration-runner.ts` shows the LLM call, the guardrail run, and
  the tool dispatch on the same call stack.
- Streaming and abort propagate as ordinary `yield` / `AbortSignal`
  semantics. There is no scheduler in between.
- Hooks are observer-only by contract — they cannot change the next
  state. This keeps the control flow grep-able from one file.
- Multi-agent orchestration is a first-class but separate concern
  (`harness-one/orchestration`), so single-agent users do not pay for
  graph machinery they don't use.

### Negative

- There is no built-in visualizer. Frameworks with explicit graphs
  get one for free; we don't.
- Users who want declarative branching ("if tool X failed, try Y") have
  to write the conditional themselves or reach for the orchestration
  module's `createBasic*Strategy` factories.
- Extending the loop with a fundamentally new stage (e.g. a
  pre-tool-call planner) means editing `iteration-runner.ts` rather
  than registering a node. We accept that cost in exchange for keeping
  the iteration shape singular.

## Evidence

- `packages/core/src/core/agent-loop.ts` — `class AgentLoop` /
  `createAgentLoop()`; `run()` is `async *run(): AsyncGenerator<AgentEvent>`.
- `packages/core/src/core/iteration-runner.ts` — per-iteration
  choreography (`runIteration`, `bailGuardrail`, `bailAborted`,
  `bailError`); explicit `yield` of every terminal exit.
- `packages/core/src/core/agent-loop-types.ts` — hook contract
  (`AgentLoopHook`); doc comment "Hooks MUST NOT throw … the loop
  continues as if the hook had returned normally."
- `packages/core/src/orchestration/orchestrator.ts` — multi-agent
  orchestration is composed on top of the loop, not replacing it.
- `docs/architecture/01-core.md` — public-facing description of the
  loop shape.
