---
'harness-one': minor
---

Three new `harness-one/testing` helpers, each closing a friction
entry surfaced from showcase / app work:

**`createSlowMockAdapter`** (showcase 04 cascade-abort)

```ts
const adapter = createSlowMockAdapter({
  response: { message, usage },
  chatDelayMs: 50,
  streamChunkDelayMs: 10,
  respectAbort: true, // default
});
```

Returns an `AgentAdapter` whose `chat()` and `stream()` artificially
delay so abort/timeout scenarios are observable without real network.
The delay is interruptible via the request `signal` (default), so
caller-driven aborts cleanly cancel the wait with an AbortError.

**`spawnCrashable`** (showcase 03 SIGKILL via pnpm wrapper)

```ts
const outcome = await spawnCrashable({
  entry: 'pnpm',
  args: ['exec', 'node', './leaf.js'],
  killAt: 50,
});
// outcome.outcome === 'killed' even when SIGKILL is laundered to exit code 137
```

Wraps `child_process.spawn` and resolves to a structured
`{ outcome: 'clean' | 'killed' | 'errored', code, signal }`.
Recognises BOTH `signal === 'SIGKILL'` AND `code === 137` (the
conventional Unix laundered-SIGKILL exit code that intermediaries
like pnpm / tsx emit when their leaf is signal-killed).

**`withTempCheckpointDir`** (HARNESS_LOG HC-017)

```ts
await withTempCheckpointDir(async (dir) => {
  const agent = createCodingAgent({ workspace, checkpointDir: dir });
  // ... checkpoints land in `dir`, not in ~/.harness-coding
});
```

Async helper that creates a realpath-collapsed temp directory, hands
it to the callback, and cleans up on exit (success OR failure).
Centralises the `mkdtemp + try/finally + rmdir` ceremony every
checkpoint-touching test was duplicating.
