---
'harness-one-coding': minor
---

Initial release of `harness-one-coding`, the autonomous coding agent vertical
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
