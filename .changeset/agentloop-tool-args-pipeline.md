---
'harness-one': minor
---

AgentLoop now runs `inputPipeline` on tool-call arguments (defense in depth).

When `AgentLoopConfig.inputPipeline` is configured, the iteration runner invokes `pipeline.runInput({ content: toolCall.arguments })` once per tool call **before** yielding the `tool_call` event and **before** the tool side-effect runs. A `block` verdict aborts the loop with `guardrail_blocked` (new phase `'tool_args'`) + `error` (`HarnessErrorCode.GUARD_VIOLATION`); the `tool_call` is never yielded.

Closes the asymmetry where direct `createAgentLoop` callers with an input pipeline previously got user-message validation but not tool-arg validation. Preset users were already covered by the outer wrapper at `harness.run()`.

**`AgentEvent['guardrail_blocked'].phase` widened** from `'input' | 'tool_output' | 'output'` to `'input' | 'tool_args' | 'tool_output' | 'output'`. This is the only public-API change. Existing exhaustive switches on `phase` (`assertNever(phase)` patterns) need to add a `case 'tool_args':` arm.

**No impact on preset users.** `createSecurePreset` / `createHarness` do not pass `inputPipeline` to the inner AgentLoop — the preset runs all guardrail phases at the `harness.run()` boundary. The new check is a no-op on the preset path.

**Caveat for direct AgentLoop users with rate-limiter inside `inputPipeline`**: the limiter sees one additional pipeline run per tool call. Lift the rate-limiter out of `inputPipeline` (compose it as a separate AgentLoop-external guard) if this is undesirable.
