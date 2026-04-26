# harness-one-coding

## 0.1.1

### Patch Changes

- Updated dependencies [f3ad6ad]
  - harness-one@1.0.1
  - @harness-one/anthropic@0.1.3
  - @harness-one/preset@1.0.1

## 0.1.0

### Minor Changes

- 350749f: Initial release of `harness-one-coding`, the autonomous coding agent vertical
  package built on `harness-one`.

  - `createCodingAgent` factory wiring the seven MVP tools (`read_file`,
    `write_file`, `list_dir`, `grep`, `shell`, `run_tests`, `git_status`),
    dual guardrail pipelines, soft-guardrail auditor (approval flow),
    checkpoint manager (FsMemoryStore at `~/.harness-coding/checkpoints/`),
    three-dimensional budget tracker, and JSONL trace exporter.
  - `harness-coding` CLI with the full DESIGN §4.2 flag surface, SIGINT/
    SIGTERM graceful-abort, `harness-coding ls` sub-command.
  - State machine: `planning → executing → testing → reviewing → done`,
    every transition persisted as a checkpoint.
  - Live Anthropic adapter end-to-end test gated on `ANTHROPIC_API_KEY` +
    `CODING_AGENT_LIVE=1`.

  See `apps/coding-agent/README.md` for the user surface and
  `apps/coding-agent/HARNESS_LOG.md` for the reuse-back log.

### Patch Changes

- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
- Updated dependencies [8a51ef1]
  - harness-one@1.0.0
  - @harness-one/anthropic@0.1.2
  - @harness-one/preset@1.0.0
