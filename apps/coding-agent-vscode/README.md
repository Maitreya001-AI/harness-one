# Harness Coding (VS Code extension)

VS Code wrapper for [`harness-one-coding`](../coding-agent), the autonomous coding agent built on `harness-one`.

## Commands

| Command | Description |
|---|---|
| `Harness Coding: Run Task` | Prompt for a task description and run the agent against the active workspace. |
| `Harness Coding: Resume Task` | Pick a checkpoint and resume. |
| `Harness Coding: List Checkpoints` | Show the most recent checkpoints in the output channel. |

## Settings

| Setting | Default | Notes |
|---|---|---|
| `harnessCoding.model` | `claude-sonnet-4-20250514` | Model name forwarded to the Anthropic adapter. |
| `harnessCoding.maxTokens` | `200000` | Token budget. |
| `harnessCoding.maxIterations` | `100` | AgentLoop iteration cap. |
| `harnessCoding.maxDurationMinutes` | `30` | Wall-clock budget. |
| `harnessCoding.approval` | `always-ask` | `auto` / `always-ask` / `allowlist`. |
| `harnessCoding.dryRun` | `false` | Refuse to mutate fs / shell when set. |

## Auth

The extension reads `ANTHROPIC_API_KEY` from the environment when constructing the adapter. Future versions will integrate with `vscode.SecretStorage` so the key never lives in shell history.

## Build

```bash
pnpm --filter harness-one-coding-vscode build
pnpm --filter harness-one-coding-vscode package   # produces a .vsix via vsce
```

## Status

Pre-release. The activation path is wired and unit-tested via an in-memory
`vscode` shim (`tests/vscode-shim.ts`); end-to-end host integration tests
are deferred — VS Code's host harness needs network and a real `code`
binary that doesn't run in CI without privileged setup.
