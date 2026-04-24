# ADR-0009 · Treat streaming size limits as hard caps, not warnings

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: harness-one maintainers

## Context

A streaming LLM response can in principle emit unbounded bytes:

- Token streams without an `end_turn` for the entire context window.
- Tool-call argument JSON that grows mid-stream as fragments arrive.
- Pathological adapters (provider bug, attacker-controlled
  intermediate proxy) that inject unbounded data into the stream.

The agent loop accumulates the streamed bytes into a
`StreamAggregator` so it can hand a complete `AssistantMessage` to
the next iteration. Without enforced caps, three things go wrong:

1. **Memory blow-up** — accumulating gigabytes of tokens in a single
   process kills the host.
2. **Cost blow-up** — pricing scales with output tokens; an
   unbounded stream is an unbounded bill.
3. **Denial of service** — a malicious upstream can wedge the loop
   indefinitely, holding sockets and adapter retries open.

## Decision

> **`MAX_STREAM_BYTES`, `MAX_TOOL_ARG_BYTES`, and `MAX_TOOL_CALLS`
> are hard limits. Crossing one terminates the iteration with a
> typed `HarnessError`; the loop never silently truncates or warns
> and continues.**

Defaults live as exported constants in
`packages/core/src/core/agent-loop-config.ts` (`MAX_STREAM_BYTES =
10 MB`, `MAX_TOOL_ARG_BYTES = 5 MB`, `MAX_TOOL_CALLS = 128`).
Adapters (`@harness-one/anthropic`, `@harness-one/openai`) accept an
optional `streamLimits` override whose defaults match the same
constants, so the loop-level cap and the adapter-level cap stay in
lockstep. `AgentLoop` additionally enforces a **secondary**
cumulative ceiling (`maxCumulativeStreamBytes = maxIterations ×
maxStreamBytes`) as a backstop against streams that stay just under
the per-iteration cap on every turn.

Bytes are counted in **UTF-8** (not UTF-16 code units), matching
what downstream serialisers see on the wire.

## Alternatives considered

- **Soft warning, continue accumulating** — log "stream exceeded
  10MB" and keep going. Rejected: the failure modes are memory and
  cost; logging without stopping doesn't actually prevent either.
- **Provider-level limit only** — trust the LLM provider's quota
  enforcement. Rejected: providers protect their own infra, not
  ours; a misbehaving proxy or mock adapter has no provider quota.
- **Cap iterations, not bytes** — `maxIterations` is a separate
  knob. Rejected: a single iteration can still blow memory; the
  byte cap is the orthogonal control.
- **Configurable to "off"** — let users disable the cap. Rejected:
  the default has to be safe, and we found no production use case
  that legitimately needs unbounded accumulation. The cap is
  configurable upward but not removable.

## Consequences

### Positive

- Memory consumption is bounded per iteration **and** cumulatively
  across the loop. OOM is no longer a failure mode of the agent
  loop itself.
- Cost is bounded too: the worst-case per-iteration token output is
  capped by the byte cap divided by the smallest token's UTF-8 size.
- Adapter and loop limits are wired to the same constants, so a
  user tightening `maxStreamBytes` for a specific deployment only
  has to change one number per side.
- The error is typed (`HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED`),
  so callers can distinguish "cap hit" from "adapter network error"
  in retry / fallback logic.

### Negative

- A legitimate long response (e.g. a verbose summary) can hit the
  cap and abort the iteration. The user has to raise the cap
  explicitly. We accept that friction; the alternative (no cap by
  default) is worse.
- The UTF-8 vs UTF-16 distinction has tripped up early users whose
  intuition was based on string `.length`. The doc comment on
  `StreamAggregator` calls this out explicitly.
- Two-level enforcement (per-iteration + cumulative) means two
  numbers to tune for advanced users. Most never touch the
  cumulative cap; it is purely a backstop.

## Evidence

- `packages/core/src/core/agent-loop-config.ts` —
  `MAX_STREAM_BYTES = 10 * 1024 * 1024`,
  `MAX_TOOL_ARG_BYTES = 5 * 1024 * 1024`,
  `MAX_TOOL_CALLS = 128`.
- `packages/core/src/core/stream-aggregator.ts` —
  `checkSizeLimits()` and the throw paths that produce
  `HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED` when bytes exceed
  `maxStreamBytes` or any tool's argument exceeds
  `maxToolArgBytes`.
- `packages/core/src/core/agent-loop.ts` — `maxCumulativeStreamBytes
= maxIterations × maxStreamBytes` is wired into the stream
  handler as a secondary backstop.
- `packages/anthropic/src/`, `packages/openai/src/` — adapter
  factories accept `streamLimits: { maxToolCalls?,
maxToolArgBytes? }` with defaults matching the shared constants.
- `docs/ARCHITECTURE.md` — "Adapter stream limits" section exposes
  the contract to PR reviewers.
