# ADR-0006 · Default guardrail pipeline to fail-closed

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: harness-one maintainers

## Context

The guardrail pipeline runs every prompt through a set of detectors
(prompt injection, content filter, PII, schema, rate limit). A
detector can:

1. Pass — return `allow`.
2. Catch a violation — return `block` (or `redact` / `transform`).
3. **Throw an exception** — the detector itself misbehaved
   (network blip to the moderation API, schema parse error, OOM).

The third case is the dangerous one. A naïve "fail-open" pipeline
treats a thrown detector as if it had returned `allow`, on the theory
that we shouldn't punish the user for a backend hiccup. The cost
of that policy is catastrophic in the worst case: a prompt-injection
detector that throws on a malicious payload silently lets the payload
through.

## Decision

> **Pipelines default to `failClosed: true`. When a detector throws,
> the pipeline blocks the request and emits a verdict whose `reason`
> distinguishes "real allow" from "fail-closed dropout" so operators
> can tell the two apart on dashboards.**

`createPipeline({ failClosed })` keeps the option for callers who
explicitly need fail-open semantics (e.g. a non-critical telemetry
sampler), but the default is closed. `createSecurePreset` wires
`failClosed: true` and offers no opt-out — callers who need an
escape hatch must drop down to `createHarness` and accept
responsibility for the insecure config.

## Alternatives considered

- **Default fail-open** — match the "don't break the user" instinct.
  Rejected: a missed detector firing is a missed safety check; the
  user pays for the failure mode (jailbroken model, leaked PII)
  without ever seeing it.
- **Configurable per detector** — let each detector pick. Rejected:
  the right policy is a property of the deployment ("how much do we
  trust this detector to be online?"), not of the detector itself.
  Per-detector config also bloats the API.
- **Fail-closed with no opt-out** — remove the `failClosed: false`
  option entirely. Rejected: there are legitimate uses (e.g. an
  experimental detector running in shadow mode); we just don't want
  the option to be reachable through the secure preset.

## Consequences

### Positive

- The default deployment shape is the safe one. A user who wires
  `createSecurePreset()` and forgets to think about exception
  semantics is still protected.
- Fail-closed dropouts are visible: the verdict reason
  (`pipeline_timeout`, `detector_error`) is distinct from a real
  block, so dashboards can split "blocked because malicious" from
  "blocked because detector misfired" and operators can chase the
  latter without losing the former's signal.
- The decision aligns with the `allowedCapabilities` default
  (`['readonly']`) for the tool registry — both surfaces default to
  the most-restrictive, least-surprising option.

### Negative

- A flaky moderation backend turns into user-visible request
  failures rather than silent acceptance. We accept that tradeoff —
  visibility is the desired property — but it does mean operators
  must monitor detector health.
- Some early adopters expected fail-open semantics (it's the
  "safer-feeling" default in some dev environments) and were
  surprised by request blocks during outages. The migration story
  is "set `failClosed: false` explicitly if you need that
  behaviour" — short, but it's a behaviour-changing knob.
- The "secure preset has no opt-out" rule means every deployment
  needing a one-off relaxation must bypass the preset entirely,
  which is more work than flipping a single boolean.

## Evidence

- `packages/core/src/guardrails/pipeline.ts` — `failClosed:
config.failClosed ?? true` (default-on); `if (pipeline.failClosed)
{ … }` branches that switch verdict between "block on error" and
  "pass through with reason recorded".
- `packages/core/src/guardrails/pipeline.ts` — timeout path computes
  `timeoutVerdict = pipeline.failClosed ? block : allow-with-reason`
  so the reason field carries the dropout cause.
- `packages/preset/src/secure.ts` — `createSecurePreset` opinionated
  wiring: "There is no 'guardrails off' escape hatch."
- `packages/core/src/tools/registry.ts` — sibling decision:
  `allowedCapabilities ?? ['readonly']` defaults to the safe set
  (cited as a capability-tier analogue of fail-closed).
- `packages/core/src/guardrails/__tests__/pipeline.test.ts` /
  `pipeline-hardening.test.ts` — witness tests for both the
  default-closed behaviour and the explicit `failClosed: false`
  opt-out.
