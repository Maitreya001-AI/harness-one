# CLAUDE.md

> Repository-level instructions that Claude Code reads at session start
> when working anywhere in this monorepo.

This is the `harness-one` monorepo — a TypeScript agent harness library.
Human-facing onboarding lives in [`README.md`](./README.md) and
[`CONTRIBUTING.md`](./CONTRIBUTING.md). This file collects the *operational*
conventions that need to influence Claude Code's behavior across sessions.

---

## Repository orientation

- `packages/` — published `harness-one` framework packages (the library
  itself).
- `apps/` — long-lived consumer applications (`dogfood`, `coding-agent`,
  `coding-agent-vscode`, `research-collab`). Each app has a
  `HARNESS_LOG.md` for capturing real-use friction against `harness-one`.
- `showcases/` — one-shot calibration projects (`01-streaming-cli`,
  `02-rag-support-bot`, `03-memory-checkpoint-stress`,
  `04-orchestration-handoff`). Each showcase has a `FRICTION_LOG.md`.
- `examples/` — short, copy-pasteable usage examples for the framework.
- `docs/` — architecture, ADRs, RFCs, RETROs, and the feedback-loop docs.
- `tools/` — repo-level tooling (size-limit, tree-shake checks, etc.).

When the user references a "subsystem" or "module", they almost always
mean one of the directories under `packages/*/src/`.

---

## Engineering conventions (short form)

- **Tests carry every change.** Project bar is near-100% coverage; CI
  enforces it. Don't ship code without tests.
- **One PR = one logical change.** Don't bundle unrelated work.
- **Primitives, not frameworks.** Prefer the smaller, more composable API.
  If you find yourself adding a fourth optional argument to a function,
  stop and reconsider.
- **TypeScript strict everywhere.** No `as any` on public boundaries; if
  the type system is fighting you, that's often a friction signal — see
  the section below.

Detailed setup, command reference, and PR/release process live in
[`CONTRIBUTING.md`](./CONTRIBUTING.md). Don't duplicate that here.

---

## Feedback automation (harness-one 反哺机制)

This repo has an active **friction-logging workflow** that you (Claude Code)
must follow. The full instructions live in
[`.claude/feedback-instructions.md`](./.claude/feedback-instructions.md).

**Read those instructions:**

1. **At the start of each session** — before responding to the first user
   request, read `.claude/feedback-instructions.md` and apply its rules
   throughout the session.
2. **Re-read at key checkpoints** — before commits, when a task is declared
   complete, or when the user mentions "我要 commit 了" / "task done" /
   similar. Long sessions drift; re-reading restores baseline behavior.

**Why this matters:**

`harness-one` improves through three reinforcing channels: examples
(learning), showcases (calibration), and apps (long-term feedback). The
"apps" channel depends entirely on **friction signals being captured
continuously** during real development work — i.e., right here, in
conversations like this one. If friction goes unrecorded, the app channel
starves and harness-one stops improving from real use.

You are not just helping the user write code. **You are also a friction
scribe.** Whenever the user works in `apps/*/` or `showcases/*/`, watch for
friction signals (defined in the instructions file) and surface them at
appropriate moments — not by interrupting flow, but by batching candidate
observations and confirming at task boundaries.

The detailed rules — what counts as friction, when to interrupt vs. batch,
which LOG file to write to, exact entry format — are all in
`.claude/feedback-instructions.md`. Do not duplicate them here.

For the human-readable rationale, see
[`docs/harness-one-feedback-automation.md`](./docs/harness-one-feedback-automation.md).
For the underlying mechanism (HARNESS_LOG format, RETRO cadence, cross-app
rules) it builds on, see
[`docs/harness-one-app-feedback-loop.md`](./docs/harness-one-app-feedback-loop.md).

### User-invocable slash commands

The following are defined in `.claude/commands/` and the user may invoke
them directly:

- `/log-friction <description>` — record a friction explicitly (skips the
  auto-detection batching loop).
- `/triage-frictions` — review pending entries across all
  `HARNESS_LOG.md` / `FRICTION_LOG.md` files and propose reflux actions.
  Suggested cadence: weekly.
- `/sync-app-frictions` — identify friction patterns shared across
  ≥2 apps, update `docs/app-frictions.md`. Suggested cadence: monthly.

Follow the per-command instructions in `.claude/commands/*.md` exactly.
Don't substitute your own judgment for the command template.
