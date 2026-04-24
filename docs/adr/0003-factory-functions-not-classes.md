# ADR-0003 · Construct primitives through factory functions, not `new`

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: harness-one maintainers

## Context

A TypeScript library can expose its primitives in three shapes:

1. **Classes**: `new SessionManager(config)`.
2. **Factory functions returning objects**: `createSessionManager(config)`.
3. **Factory functions returning class instances**: `createSessionManager(config)` returning a `SessionManager` instance.

Choosing one shape per primitive matters because it pins down what
users type at every call site, what TypeScript can narrow, and what
the test surface looks like. Mixing shapes within one library forces
users to remember which primitive uses which constructor style.

## Decision

> **Public primitives are constructed through `create*` factory
> functions; the implementing class, if any, stays internal.**

Factories return objects that implement a documented `interface` (e.g.
`createSessionManager(): SessionManager`). The class, if there is one,
is not exported. State that needs to be hidden lives in the closure
the factory creates, not on `private` fields.

`AgentLoop` is the documented exception: the factory `createAgentLoop`
is the idiomatic entry point, but the class is also exported so
tooling can narrow with `instanceof AgentLoop` (the only place where
the public contract relies on identity narrowing).

## Alternatives considered

- **Classes everywhere** — uniform `new ClassName(config)`. Rejected:
  `private` fields are not actually private (still enumerable on the
  instance, accessible via `(obj as any).field`); constructors can't
  return a different shape per options; class hierarchies tempt
  inheritance where composition would do.
- **Mix per primitive** — some classes, some factories, picked case
  by case. Rejected: users have to memorize which is which, and
  adding a new primitive becomes a style debate every time.
- **Builder pattern** (`SessionManager.builder().build()`) — common
  in Java land. Rejected: TypeScript's argument-destructuring + literal
  types already give us named, optional, validated arguments; the
  builder adds boilerplate without buying anything we didn't already
  have.

## Consequences

### Positive

- Closure-scoped state is genuinely unreachable. There is no `private`
  escape hatch via casting to `any`.
- The factory can return different concrete shapes per options
  without breaking the public type. Discriminated-union returns
  narrow cleanly at the call site.
- API consistency: every public primitive starts with `create*`. New
  contributors don't have to ask which form to use.
- Test fakes are trivial — return a plain object that satisfies the
  interface; no inheritance dance.

### Negative

- `instanceof` narrowing is unavailable for most primitives. We
  carved a single exception for `AgentLoop` because its run-event
  generator return type is hard to narrow without it.
- The constructor-vs-factory question recurs whenever a contributor
  ports a class-shaped pattern from another codebase. The lint
  surface doesn't catch this; PR review does.
- Some IDE refactors (rename class, "find all instances") work less
  well on closure objects than on classes.

## Evidence

- `packages/core/src/core/agent-loop.ts` — `createAgentLoop()` factory;
  `class AgentLoop` is exported as the documented exception.
- `packages/core/src/session/manager.ts` — `createSessionManager()`
  returning a `SessionManager` interface; no class exported.
- `packages/core/src/observe/trace-manager.ts`,
  `packages/core/src/observe/cost-tracker.ts`,
  `packages/core/src/observe/logger.ts` — `createTraceManager`,
  `createCostTracker`, `createLogger` factories.
- `packages/core/src/tools/registry.ts` — `createRegistry()` /
  `createPermissiveRegistry()` factories.
- `docs/ARCHITECTURE.md` — "Construction: factories, not classes"
  section restates this rule and the `AgentLoop` exception.
