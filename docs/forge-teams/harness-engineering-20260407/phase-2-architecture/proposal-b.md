# Architecture Proposal B: "Production-Grade DX"

**Philosophy**: Builder patterns, class-based stateful components, branded types, IntelliSense-first
**Style**: Drizzle, tRPC, Fastify

## Key Decisions
- Builder patterns for complex configs (AgentLoop, TokenBudget, GuardrailPipeline)
- Classes for stateful components (5 total), functions for stateless operations
- Branded types: TokenCount, ModelId (compile-time safety)
- Rich error hierarchy with `.suggestion` on every error
- Core defines shared Message type; other modules depend on core/types
- GuardrailVerdict: allow | block | modify (3-way discriminated union)
- Result<T,E> type for expected failures

## Directory Structure
Same as Proposal A with addition of:
- `src/errors/` — dedicated error hierarchy module
- `src/_internal/branded.ts` — branded type helpers
- `src/_internal/result.ts` — Result<T,E> type
- `src/guardrails/builtins/` — subdirectory for built-in guardrails
- `src/context/compression/` — subdirectory for compression strategies

## Dependency Graph (acyclic)
- errors/ → nothing (leaf)
- _internal/ → errors/
- core/ → _internal/, errors/ (defines shared types: Message, AgentAdapter, AgentEvent)
- context/ → core/ (for Message type), _internal/, errors/
- tools/ → core/ (for Message type), _internal/, errors/
- guardrails/ → core/ (for Message type), _internal/, errors/

## Estimated: ~13.5 days effort

## 6 ADRs: Builder Pattern, Branded Types, Errors as Feedback, No Root Export, Single Package, Class-Based Stateful Components

(Full proposal with complete TypeScript interfaces on file)
