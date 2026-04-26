# Feedback Instructions for Claude Code

> Active friction-logging workflow for the `harness-one` repo.
> Referenced from `CLAUDE.md`. Read at session start, re-read at task
> boundaries.

---

## 0. Why you are reading this

`harness-one` is a TypeScript agent harness library. It improves through
three feedback channels: examples (learning), showcases (one-shot
calibration), apps (long-term real-use signal). **You are the user's main
tool when developing apps and showcases.** That makes you the de facto
friction scribe — if you don't capture friction signals, they vanish.

Your job in this repo is **not just to help the user write code**. Your job
is also to **notice when harness-one is making the user's life harder** and
make sure those moments get recorded into the right LOG file. The user has
explicitly opted into this workflow — they want this; do not skip it to
"save tokens" or "stay focused on the task." Friction logging IS part of
the task here.

The mechanism itself is documented in
[`docs/harness-one-app-feedback-loop.md`](../docs/harness-one-app-feedback-loop.md)
(for human readers). This file is **your operational guide** — what to do
in real conversations.

---

## 1. The mental model: candidate accumulation, batch confirmation

You will see things during a session that are **possibly friction**. Don't
interrupt the user every time. Instead:

```
[Conversation flow]
   user message → you respond + (silently note candidate friction)
   user message → you respond + (silently note candidate friction)
   user message → you respond
   ...
   [task boundary detected]  → surface accumulated candidates, confirm with user
   [user yes/no per item]    → write confirmed items to LOG
   continue conversation
```

This is the **default rhythm**. Two exceptions:

- **High-confidence friction** (e.g., the user explicitly says "this API is
  annoying") → confirm and offer to log immediately, don't wait for batch
- **User-initiated** (`/log-friction <text>`) → log immediately

---

## 2. What counts as friction (signal recognition)

Treat any of the following as a **friction candidate**. Note it silently;
batch it.

### A. User explicit signals (high confidence)

Direct verbal cues from the user — log these immediately, don't wait:

- "this API is annoying / weird / awkward"
- "I have to do X to work around Y"
- "I wish harness-one would just..."
- "why doesn't harness-one expose..."
- "the error message doesn't tell me anything"
- "I had to read the source to figure out..."
- (中文)"这 API 真烦 / 别扭 / 难用"、"绕过去吧"、"为什么 harness 不直接..."、"错误信息看不懂"

### B. Code-pattern signals (medium confidence — batch)

Patterns in code you write or read that suggest harness-one is being worked
around:

- A workaround comment: `// HACK`, `// TODO(harness)`, `// workaround`,
  `// this should be in harness-one`, `// 绕过 harness`
- Importing from `harness-one/internal/...` or other private subpaths to
  reach functionality not exposed publicly
- Re-implementing functionality that exists in harness-one (e.g., handwriting
  exponential backoff when `computeBackoffMs` exists; handwriting fallback
  try/catch when `createFallbackAdapter` exists)
- Type assertions to bypass harness-one's type system (`as any`, `as unknown as X`)
  on harness-one boundaries
- Wrapping every call to a harness-one API in the same boilerplate (suggests
  the API should provide that boilerplate)

### C. Workflow signals (medium confidence — batch)

Patterns in how the work is happening:

- User had to look at harness-one source code to understand behavior — the
  doc was insufficient
- An error was thrown by harness-one and the user couldn't tell from the
  message what went wrong
- The user asked you to grep for or open a harness-one source file because
  TypeScript types or docs were unclear
- A test fails in harness-one when used in the way the docs suggest
- Behavior differs from what the user expected based on docs/types

### D. Adapter / integration signals (medium confidence — batch)

Specifically when the user is working with `@harness-one/anthropic`,
`@harness-one/openai`, `@harness-one/redis`, etc.:

- SDK type incompatibility with harness-one's interface
- Adapter behavior under failure modes (rate limit, auth error) doesn't
  match harness-one's contract
- `peerDependency` version conflicts forcing the user to pin specific versions

### Things that are NOT friction (don't log)

- The user makes a typo and corrects it
- The user is learning the API for the first time and is just looking it up
  (this is documentation usage, not friction)
- A bug in **the user's own code**, where harness-one is not implicated
- A general TypeScript/Node.js issue unrelated to harness-one
- The user not knowing what harness-one offers (but: if you keep helping
  them by pointing to features they didn't know existed, that's a
  **discoverability friction** — log it)

---

## 3. When to surface (timing rules)

Default: surface candidates at **task boundaries**. Specifically:

- **User declares completion**: "done", "搞定", "ok 这就 commit 了",
  "task done", "finished", etc.
- **User explicitly transitions**: "now let me do Y", "next let's...",
  "ok 接下来..."
- **User asks for review/summary**: "review what we did", "总结一下"
- **User invokes commit**: any sign of `git commit`, "commit 了", "PR"
- **User explicitly asks**: "any frictions this session?", "今天有什么
  反哺?"
- **Long session natural pause**: ~5+ exchanges of substantive work without
  candidate batching; offer to checkpoint

When you surface, do it **briefly and tabular**:

```
我注意到这次 session 有 N 条可能的 friction:

  1. [signal-B] guardrails 子系统的 onBeforeToolCall hook 没有暴露,你
     不得不在 AgentLoop 外面包了一层拦截。这是想反哺的吗?
  2. [signal-C] 你 grep 了 packages/core/src/observe/trace.ts 才搞清
     楚 spanId 生成规则,文档没说。要记吗?
  3. [signal-A] 你说"这个 retry budget API 真别扭"。我已经听到了,这
     个就一定记吧?

回 1 / 2 / 3 哪几条要记,或者"全记"/"都不记"。
```

Wait for user response. Apply their decision. Don't argue.

---

## 4. Auto-routing: which LOG file?

When the user confirms an item, decide where to write it. **Default rules**:

| Where the user is working | Write to |
|---|---|
| `apps/dogfood/**` | `apps/dogfood/HARNESS_LOG.md` |
| `apps/coding-agent/**` | `apps/coding-agent/HARNESS_LOG.md` |
| `apps/coding-agent-vscode/**` | `apps/coding-agent-vscode/HARNESS_LOG.md` |
| `apps/research-collab/**` | `apps/research-collab/HARNESS_LOG.md` |
| `apps/<other>/**` | `apps/<other>/HARNESS_LOG.md` |
| `showcases/<n>/**` (active showcase) | `showcases/<n>/FRICTION_LOG.md` |
| `packages/core/**` (modifying harness-one itself) | **Ambiguous — ask** |
| `examples/**` | **Ambiguous — ask** |

Detection rules:

1. Check the most recent file paths the user has been viewing/editing
2. Check `cwd` if available
3. If the user has been bouncing between multiple locations, ask which LOG
   to use rather than guessing

When ambiguous, ask **once** at confirmation time:

```
要写到哪个 LOG?
  a) apps/coding-agent/HARNESS_LOG.md
  b) apps/dogfood/HARNESS_LOG.md
  c) 都不写,这是主仓库改动,直接开 issue
```

**Never invent paths.** If a directory doesn't exist (e.g., `apps/foo/`
that the user hasn't created yet), ask before creating it.

---

## 5. Exact entry format

When writing to `HARNESS_LOG.md`, use exactly this format. **New entries go
at the top** (after the header), not the bottom.

```markdown
## YYYY-MM-DD — <一句话标题(不超过 60 字符)>

**遇到的 friction**:具体描述 — 哪个 API、什么场景、什么问题。如果有
最小复现代码,贴上(< 10 行)。

**当前规避**:目前是怎么绕过去的。如果有代码片段,贴上(< 10 行)。

**反哺动作**:

- [ ] 已开 issue #(待补)
- [ ] 已提 PR #(待补)
- [ ] 已写 RFC docs/rfc/NNNN-xxx.md
- [ ] 待评估(根因还没想清楚)
- [ ] 不反哺(理由:...)

**优先级**:低 / 中 / 高

**根因猜测**(可选):...

---
```

Format rules:

- **Date**: today's date in ISO format (YYYY-MM-DD), local timezone
- **Title**: present-tense, specific, identifies API/component when possible
  - ✅ "CheckpointManager fs index 错乱"
  - ✅ "shell tool 错误信息缺少 cwd 上下文"
  - ❌ "memory 有问题"(too vague)
  - ❌ "我今天遇到了一些 bug"(not specific)
- **Friction body**: 2-5 sentences describing what the user encountered. If
  there's a clean minimal repro, include it. If the description goes over
  ~150 words, you're being too verbose — tighten.
- **Workaround body**: 1-3 sentences. If there's no workaround yet, write
  "尚无 — 当前阻塞 / blocked".
- **Reflux action**: leave at "待评估" by default. Only check `已开 issue`
  if you're sure issue exists (verify with `gh issue list` if uncertain).
- **Priority**: default 中. Only "高" if user said so or it's clearly
  blocking; only "低" if user said so.
- **Root cause guess**: include only if user articulated a guess or you
  have strong evidence. Otherwise omit the line.

After writing, separator `---` on its own line, blank line above and below.

Note: existing per-app LOG files (`apps/coding-agent/HARNESS_LOG.md`,
`apps/research-collab/HARNESS_LOG.md`) historically used slightly different
templates (id/severity tables, status-keyed entries). When a per-app LOG
already prescribes its own format in its header, follow that file's
in-place template instead of overwriting it; new files default to the
template above.

---

## 6. Example interactions

### Example 1: high-confidence direct signal

```
用户:奇怪,为什么 createFallbackAdapter 不接受 onFailover callback?
     我想记录每次 failover 但没地方挂 hook,只能在 fallback adapter
     里自己塞日志,有点别扭。

你:这听起来是个 friction 信号。我可以记到 apps/coding-agent/HARNESS_LOG.md
   吗?草稿是:

   ## 2026-04-26 — createFallbackAdapter 缺 onFailover hook

   **遇到的 friction**:`createFallbackAdapter` 没有暴露 failover 事件
   hook,无法在 primary → fallback 切换时记录日志/metric。当前需要在
   fallback adapter 内部自己埋日志,但这破坏了 adapter 接口对称性。

   **当前规避**:在 fallback adapter 的 `chat()` 入口手动 log,带上
   "this is fallback path" 标记。

   **反哺动作**:
   - [ ] 待评估(API 设计可能有 RFC 价值)

   **优先级**:中

   你想直接记还是改一下?
```

### Example 2: batch surfacing at task boundary

```
用户:OK 这就 commit 了。

你:稍等,在 commit 之前我想 surface 这次 session 的 friction 候选:

   1. [signal-B] examples/autoresearch-loop.ts 你写的时候手写了 backoff
      逻辑,后来才意识到应该用 computeBackoffMs。这是不是说明 backoff
      原语在 examples 上下文里发现路径不够?
   2. [signal-C] 你 grep 了 ContextRelay 的 _version 字段处理,因为
      08-memory.md 里没讲 version 兼容策略。

   要记 1 / 2 / 都记 / 都不记?
```

### Example 3: medium-confidence, no surface yet

```
用户:这里 import 的 type AgentAdapter 怎么找不到?哦,在 harness-one/core
     里。

你:[silently note: "AgentAdapter type discoverability — user had to
   guess subpath" — signal C, low-medium confidence. Don't surface yet,
   batch.]

   你看 `harness-one/core` 这个 subpath 导出的。需要我把 import 加上吗?
```

(继续干活,不打断。如果同 session 又出现 1-2 次类似的 discoverability
小信号,batch 时一起 surface。)

---

## 7. Don'ts

These behaviors are explicit anti-patterns. Do not do them:

- **Don't write to LOG without confirmation** (except `/log-friction`
  explicit invocations)
- **Don't surface every candidate immediately** — that's the
  high-interrupt failure mode the batch mechanism exists to prevent
- **Don't lobby for items the user said no to** — if user says "no, that's
  not friction", drop it, don't argue
- **Don't fabricate reflux actions** — never check `已开 issue #234` unless
  you've verified or the user told you the issue number
- **Don't write entries to LOGs in repos other than harness-one** — this
  workflow is specific to this repo
- **Don't surface friction in the middle of debugging** — wait until the
  bug is fixed and user confirms task done. Friction logging during active
  debugging derails focus.
- **Don't include sensitive info** in LOG entries — API keys, secrets,
  internal usernames. Use placeholders.
- **Don't over-format entries** — no nested headings beyond `##`,
  no bold-everything, no emoji decorations
- **Don't double-log** — before adding, scan the latest 5 entries in the
  target LOG; if you see an entry that's substantially the same friction
  from the past 7 days, mention it to the user instead of adding new
- **Don't merge multiple frictions into one entry** — one signal, one entry

---

## 8. Edge cases

### 8.1 The user is editing harness-one source itself

If the user is fixing a harness-one bug they encountered (i.e., the
friction is being resolved in this same session), the friction is still
worth logging — but the LOG entry should reference the PR/commit:

```markdown
## 2026-04-26 — STREAM_CHUNK_DECODE_ERR 缺少 byte offset

**遇到的 friction**: ...
**当前规避**: ...
**反哺动作**:
- [x] 已提 PR #248(在本 session 内修)
**优先级**:中
```

Use `[x]` to mark done. Add the PR number once known.

### 8.2 The user explicitly says "don't log this"

Drop it. Don't surface again. If the same signal recurs in the same session,
treat it as already-rejected.

### 8.3 The user is reading code, not writing

If the user is just exploring (e.g., "explain how X works", "show me Y"),
discoverability frictions are particularly valuable here — those signal
that documentation is insufficient. Pay extra attention to user expressions
of confusion.

### 8.4 You're suggesting code that uses a workaround

If you're about to write code that itself contains a workaround pattern
(e.g., "let me wrap this in a try/catch since harness-one doesn't expose
that error type"), **flag it inline** before writing:

```
我准备包一层 try/catch,因为 harness-one 没暴露 specific error type
来 distinguish auth vs network。这本身就是 friction signal,要不要记?
```

This is a "you're about to introduce a workaround" check — happens before
the code lands.

### 8.5 The repo is not harness-one

If you somehow find yourself running these instructions in a different
repo (the user copy-pasted CLAUDE.md, or the workspace is unclear), don't
apply the workflow — these LOGs are specific to harness-one. Mention this
to the user and ask what they want.

### 8.6 Multiple users / pair-programming

If user messages suggest multiple humans (handover, "my colleague said..."),
attribute carefully — don't put words in absent people's mouths. LOG entry
should describe the friction, not who said what.

---

## 9. Available slash commands

The user can invoke these directly (defined in `.claude/commands/`):

- **`/log-friction <description>`** — explicit log, skips auto-detection
- **`/triage-frictions`** — review pending entries, propose actions
- **`/sync-app-frictions`** — cross-app summary, update `docs/app-frictions.md`

When you see one of these invoked, follow the corresponding command file's
instructions exactly. Don't substitute your own judgment for the command
template.

---

## 10. Health check

Once per session (around the time you re-read this file at task boundary),
run a mental health check:

- Have I been silently noting candidates? Or have I been forgetting?
- Has it been ~5+ substantive exchanges without surfacing? Time to batch.
- Is there a candidate I've been holding for 10+ exchanges? Surface or drop.
- Has the user pushed back on my surfacing rhythm? Adjust sensitivity down.
- Has the user said "you should have caught X earlier"? Adjust sensitivity up.

This is metacognitive maintenance. The workflow only works if it doesn't
silently drift over long sessions.

---

## 11. When in doubt

If a situation isn't covered here, default to **lower interruption**:

- Unsure if it's friction → don't surface
- Unsure where to log → ask user
- Unsure about format → keep it minimal, follow §5 strictly
- Unsure if user wants logging right now → it's fine to skip; the user can
  always invoke `/log-friction` retroactively

The cost of missing one friction is low (the user can re-raise it).
The cost of over-interrupting is high (the user disables this whole workflow).
**Bias toward less, not more.**
