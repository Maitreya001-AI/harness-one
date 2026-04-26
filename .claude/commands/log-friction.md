---
description: 显式记录一条 harness-one friction,跳过自动识别
---

# /log-friction

User invoked you to record a friction observation directly. Skip the
auto-detection batching workflow — the user has already decided this is
worth logging.

## What to do

1. **Parse the user's input**: the text after `/log-friction` is the raw
   friction description. It may be just a one-liner, or it may be detailed.

2. **Determine target LOG file** following the auto-routing rules in
   `.claude/feedback-instructions.md` §4. If ambiguous, **ask once**:
   ```
   要写到哪个 LOG?
     a) apps/coding-agent/HARNESS_LOG.md
     b) apps/dogfood/HARNESS_LOG.md
     c) <next plausible candidate>
   ```

3. **Draft the entry** following the format in `feedback-instructions.md`
   §5. If the user only gave a one-liner, expand it minimally — fill in
   what you can infer from context, but **do not fabricate**:
   - For the title: distill the one-liner to ≤60 chars
   - For "遇到的 friction": expand on what was said, draw from recent
     conversation context if the friction was visible there
   - For "当前规避": leave as "尚无 — 当前阻塞" if not stated
   - For "反哺动作": leave at "待评估"
   - For "优先级": default 中,unless user said high/low

4. **Show draft to user before writing**:
   ```
   要写入 apps/coding-agent/HARNESS_LOG.md:

   ---
   ## 2026-04-26 — <title>

   **遇到的 friction**: ...
   **当前规避**: ...
   **反哺动作**:
   - [ ] 待评估
   **优先级**:中
   ---

   OK 吗?(yes 写入 / 改 X / 取消)
   ```

5. **On user confirm**:
   - Open the target LOG file
   - Insert the entry **at the top** (after the file's header, before any
     existing entries)
   - Make sure to include the `---` separator
   - Confirm completion: "已写入 apps/coding-agent/HARNESS_LOG.md"

6. **On user "改 X"**: apply the change and re-show draft for confirm.

7. **On user "取消"**: don't write. Note: the friction is now in conversation
   history, so if the user re-invokes `/log-friction` later you can reference it.

## Edge cases

- **No content after `/log-friction`**: Ask "要记什么 friction?简短描述
  一下,或者把刚才提到的 X 记下来吗?"

- **Target LOG file doesn't exist**: Tell user "apps/<x>/HARNESS_LOG.md
  还不存在。要创建吗?(创建 / 选别的位置)"

- **Same friction was just logged within this session**: Don't refuse,
  but flag: "这条跟刚才 11:32 那条很接近,是新的 instance 还是想合并?"

- **The "friction" is actually a `harness-one` bug** (not just awkward,
  but wrong): still log it as friction, but suggest in the same response:
  "这看起来是 harness-one 的 bug 不是 ergonomic 问题。除了 LOG 之外,
  要不要顺手 `gh issue create` 开个 issue?"

## Don't

- Don't apply the auto-detection batching workflow — user already decided
- Don't fabricate fields user didn't provide; mark them placeholders
- Don't fabricate `已开 issue #` numbers — only check that box if user
  gave a real number or said they opened one
- Don't write to LOGs outside `apps/*/HARNESS_LOG.md` or
  `showcases/*/FRICTION_LOG.md` — this is specifically for those
- Don't echo the entire `feedback-instructions.md` rules to user — they
  invoked a command, just do it
