---
description: 扫一遍待评估的 friction 条目,提议反哺动作
---

# /triage-frictions

User wants to review pending friction entries (status "待评估") across all
HARNESS_LOG.md files and propose specific reflux actions. This is a periodic
maintenance command — typically run weekly or after a few days of
accumulating entries.

## What to do

1. **Discover all LOG files**:
   ```bash
   find apps/ showcases/ -name 'HARNESS_LOG.md' -o -name 'FRICTION_LOG.md'
   ```
   List the files you found before reading them.

2. **Read each LOG** and extract entries with:
   - `[ ] 待评估` checked (status pending), OR
   - **All checkboxes empty** (no action decided yet)

   Skip entries marked `[x]` for any reflux action — they're already done.

3. **Summarize what you found**:
   ```
   找到 N 条待 triage 的 friction:

   apps/coding-agent/HARNESS_LOG.md:
     1. 2026-04-26 — createFallbackAdapter 缺 onFailover hook (优先级:中)
     2. 2026-04-23 — guardrails onBeforeToolCall hook 不存在 (高)

   apps/dogfood/HARNESS_LOG.md:
     3. 2026-04-22 — issue triage 时 PromptBuilder 找不到 ... (低)

   showcases/01-streaming-cli/FRICTION_LOG.md:
     4. 2026-04-20 — StreamAggregator UTF-8 边界处理 ... (中)
   ```

4. **For each entry, propose a specific action**. Be concrete — not
   "也许开个 issue",而是 "建议:开 issue 标题为 '...',label 为 ...,
   优先 milestone 为 ..."。Categories:

   - **真 bug** → 建议 `gh issue create` + 起草 issue body
   - **API ergonomic** → 建议看是否需要 RFC,起草 RFC outline
   - **文档缺陷** → 建议改哪个 markdown 文件,起草改动
   - **可在 ROADMAP 沉淀** → 建议加进 ROADMAP.md,起草条目
   - **跨 app 出现 ≥2 次** → 建议 `/sync-app-frictions`
   - **应该不反哺**(误报、已变更等)→ 建议改成 `[x] 不反哺` + 理由

   Output format per entry:
   ```
   ### Entry 1: createFallbackAdapter 缺 onFailover hook
   分类:API ergonomic
   建议动作:写 RFC `docs/rfc/00NN-fallback-failover-hook.md`
   理由:这影响 observability 集成,值得 RFC 讨论 hook 形态(callback?
        emitter?)
   起草 outline(可选): ...
   ```

5. **Present batched proposal** to user, then **wait for direction**:
   ```
   12 条 triage 完。要执行哪些?
   - "全部按建议" → 我开 issue / 起草 RFC / 改 LOG checkbox
   - "1, 3, 5" → 只对这几条执行
   - "1 改成 ROADMAP 不要 RFC,其他按建议" → 调整后执行
   - "我自己来" → 不执行,你只看我的分析
   ```

6. **On user direction, execute**:
   - For "开 issue":use `gh issue create` (or instruct user to do so if gh
     not available),记下返回的 issue number
   - For "起草 RFC":创建 `docs/rfc/00NN-<topic>.md` with the outline you
     proposed (assign next available NN)
   - For "更新 LOG":edit the LOG file's entry — check the appropriate
     checkbox, fill in the issue/PR/RFC reference
   - For "加 ROADMAP":append to `docs/ROADMAP.md` if it exists; if not,
     create stub

   **After executing each item**, immediately update the corresponding LOG
   entry's checkbox. The point of triage is to get entries OUT of the
   "待评估" state.

7. **Final report**:
   ```
   triage 完成:
   - 开了 3 个 issue: #281, #282, #283
   - 起草了 1 个 RFC: docs/rfc/0024-fallback-failover-hook.md
   - 1 条标记不反哺
   - 1 条加进 ROADMAP
   - LOG 文件相应更新
   - 还有 6 条保持 "待评估"(用户说自己来 / 没决定)
   ```

## Edge cases

- **0 待 triage 条目**: 报告 "所有 friction 都已 triage 过了 ✓",建议用户
  考虑下次 RETRO 时间。

- **过多条目(>20)**: 建议分批 triage:"条目较多,建议先 triage 优先级
  高的 N 条,其他下次。要这样吗?"

- **不能跑 `gh` 命令**: 起草 issue body but ask user to create manually,
  give them the exact text and gh command:
  ```
  请运行(我没权限直接调用 gh):
  gh issue create --title '...' --body '...' --label friction
  ```

- **RFC 编号冲突**: ls `docs/rfc/`,find next available number,don't
  hardcode.

- **跨 app 高频项**: 如果某条 friction 看起来在多个 LOG 出现,先建议跑
  `/sync-app-frictions`,不在 triage 内单独处理。

## Don't

- Don't actually open issues / create files / modify LOGs without user
  confirmation — propose first, execute on direction
- Don't apply blanket actions like "全部开 issue" without thinking — some
  entries don't need issues
- Don't propose actions for entries already marked `[x]` for any action
- Don't change priority levels — that's the user's call
- Don't merge similar entries into one — preserve original entries,
  cross-link instead
