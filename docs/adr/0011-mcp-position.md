# ADR-0011 · Keep core MCP-agnostic; ship Model Context Protocol interop as a sibling bridge package

- **Status**: Accepted (position; implementation tracked in [ROADMAP](../ROADMAP.md))
- **Date**: 2026-07-03
- **Deciders**: harness-one maintainers

## Context

The [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) is
gaining traction as a standard way for hosts to expose tools, resources,
and prompts to models. Users will reasonably ask "does harness-one speak
MCP?" — they want to consume an MCP server's tools inside an `AgentLoop`,
or expose their harness tools to an MCP host.

The naïve way to satisfy that ask is to teach core about MCP directly:
import the MCP TypeScript SDK, add MCP types to the tool registry, and
translate MCP tool calls inside the loop. That collides with two standing
decisions:

1. **Zero runtime dependencies in core** ([ADR-0004](./0004-zero-runtime-deps-in-core.md)).
   The MCP SDK (and its transport/JSON-RPC deps) would land in every
   consumer's install graph, whether or not they use MCP.
2. **The port-in-core / implementation-in-sibling pattern**
   ([ADR-0010](./0010-observe-port-vs-implementation.md)). Every place a
   vendor SDK might plug in, core defines a minimal interface and the SDK
   lives in a sibling package. MCP is exactly this shape: a protocol whose
   spec and SDK will churn on their own cadence.

Core already has its own minimal, protocol-neutral tool contract
(`ToolSchema` + `defineTool`) and content-loading seams (`rag` / `memory`
loaders). MCP is a *translation target*, not a new core concept.

## Decision

> **`harness-one` core stays MCP-agnostic. Model Context Protocol interop
> ships as a separate `@harness-one/mcp` sibling package that translates
> between MCP and harness-one's existing primitives — MCP server tool
> definitions → `defineTool()` / `ToolSchema`, and MCP resources → `rag` /
> `memory` loaders — following the ADR-0010 port pattern.**

Concretely:

- Core keeps its own minimal `ToolSchema` and `defineTool()`; no MCP types
  appear anywhere under `packages/core/src/`.
- `@harness-one/mcp` depends on `harness-one` (and the MCP SDK), never the
  reverse. It exposes helpers that take an MCP client/server and return
  ordinary harness-one tools and loaders the loop already understands.
- The bridge owns all protocol churn: transport quirks, JSON-RPC framing,
  MCP spec version drift. When MCP changes, only the sibling package moves.

This ADR records the **position**. The package itself is planned, not yet
shipped — its build-out is tracked in
[`docs/ROADMAP.md` → "MCP interop"](../ROADMAP.md#mcp-interop).

## Alternatives considered

- **MCP support inside core** — import the MCP SDK, add MCP types to the
  tool registry. Rejected: violates ADR-0004 (every consumer pays for the
  MCP graph) and ties core's release cadence to the MCP spec.
- **Re-export MCP types from core as a "neutral" tool surface** — mirror
  the MCP tool shape in core so no translation is needed. Rejected: same
  failure mode as the observability case in ADR-0010 — re-exports still
  take the dependency at type-resolution time, and it welds our tool
  contract to whichever MCP schema version we copied.
- **A user-land example instead of a package** — document the translation
  in `examples/` and let each consumer hand-roll it. Rejected: the
  MCP↔`ToolSchema` mapping (capabilities, JSON-Schema params, resource →
  loader) is non-trivial and would be re-implemented, subtly differently,
  by every consumer — the exact "belongs in a shared package" signal.
- **Do nothing** — no MCP story at all. Rejected: MCP interop is a real,
  recurring ask; declining to answer it just pushes users to fork.

## Consequences

### Positive

- Core keeps its zero-dependency promise and its protocol-neutral tool
  contract. A consumer who never touches MCP never pays for it.
- The MCP spec can evolve at its own pace; the blast radius of a breaking
  MCP change is one sibling package, not the whole library.
- The translation is written and tested once, in one place, against the
  same `AgentAdapter` / `ToolSchema` contracts the rest of the library
  already uses.

### Negative

- MCP users install a second package and learn the bridge surface — the
  same "know the package layout" discovery cost ADR-0010 accepts for
  observability backends.
- The bridge can only expose what maps cleanly onto `ToolSchema` /
  loaders; MCP features with no harness-one analogue need bespoke wiring
  outside the port, or don't cross the bridge at all.
- Until `@harness-one/mcp` ships, the answer to "does it speak MCP?" is
  "not yet, by design" — a position, not a feature.

## Evidence

- `packages/core/src/core/types.ts` — `interface ToolSchema` (core's own
  minimal, protocol-neutral tool contract; no MCP import).
- `packages/core/src/tools/define-tool.ts` — `defineTool()`, the
  translation *target* an MCP tool definition maps onto.
- `packages/core/src/rag/index.ts` — `createTextLoader` /
  `createDocumentArrayLoader`, the loader seam MCP resources map onto.
- `packages/core/package.json` — empty `dependencies`; adding MCP here is
  what this ADR forbids ([ADR-0004](./0004-zero-runtime-deps-in-core.md)).
- [ADR-0010](./0010-observe-port-vs-implementation.md) — the
  port-in-core / implementation-in-sibling pattern this ADR applies to MCP.
- `docs/ROADMAP.md` → "MCP interop" — where the `@harness-one/mcp`
  build-out is tracked.
