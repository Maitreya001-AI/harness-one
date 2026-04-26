---
description: 扫所有 apps 的 HARNESS_LOG,识别跨 app 系统性 friction,更新 docs/app-frictions.md
---

# /sync-app-frictions

User wants to identify friction patterns appearing across multiple apps —
these are the highest-priority systemic issues. Update `docs/app-frictions.md`
with current state.

## What to do

1. **Discover app LOGs**:
   ```bash
   find apps/ -name 'HARNESS_LOG.md'
   ```
   Note: only apps, not showcases. showcase FRICTION_LOG is one-shot,
   doesn't go into cross-app summary.

2. **For each LOG, extract a structured list**:
   - title
   - date
   - status (`[x] resolved` / pending)
   - which subsystem(s) it touches (infer from title/body)
   - priority

3. **Identify cross-app patterns**. A pattern is "cross-app" if:
   - **Same root cause** appears in ≥2 apps' LOGs (even if titles differ)
   - **Same harness-one subsystem** has ≥2 entries across apps within last
     90 days
   - **Same API ergonomic complaint** comes up in ≥2 apps

   Use semantic judgment, not just string match — entries titled differently
   may be the same root issue.

4. **Read existing `docs/app-frictions.md`** if it exists. Identify:
   - Active items still active?
   - Active items now resolved (PR merged + 1 month + 0 recurrence in LOGs)?
     → move to "Resolved"
   - New cross-app patterns to add to "Active"?

5. **Propose update** to user:
   ```
   docs/app-frictions.md 更新提议:

   ### 新增 Active 项目(2 条)

   1. **CheckpointManager 在并发场景下的 race condition**
      - 出现于:apps/coding-agent/HARNESS_LOG.md (2 条) +
        apps/dogfood/HARNESS_LOG.md (1 条)
      - 关联 issue: #234
      - 建议跟踪

   2. **错误信息缺少 source agent 标识**
      - 出现于:apps/coding-agent (1 条) + apps/research-collab (2 条)
      - 关联 RFC: docs/rfc/0024

   ### 转 Resolved(1 条)

   - "shell tool 错误信息缺少 cwd"
     - 已 PR #245 合并,4 周内 0 复现
     - 移到 Resolved 章节

   ### 保持 Active 不变(2 条)

   - ...

   要执行更新吗?(yes / 调整 / 取消)
   ```

6. **On user yes**: update `docs/app-frictions.md` accordingly. If the file
   doesn't exist, create it using this template:
   ```markdown
   # Cross-App Friction Summary

   > 本文档汇总在 ≥2 个 apps 中出现的 friction。这些是系统性问题。
   > 维护节奏:每个 app 完成 RETRO 后,扫一遍其他 apps 的 HARNESS_LOG
   > 寻找交叉。可通过 `/sync-app-frictions` 自动同步。

   ---

   ## Active(尚未根治)

   <items here>

   ---

   ## Resolved(已根治,留作历史)

   <items here>

   ---

   ## 维护节奏

   每完成一份 RETRO 后:

   1. 浏览本期所有 RETRO 提到的反哺动作
   2. 跟其他 apps 的 HARNESS_LOG 对照
   3. 出现 ≥2 个 app 的 → 提升到 Active 章节
   4. PR 合并 + 1 月观察期 + 0 复现 → 转 Resolved
   ```

7. **Final report**:
   ```
   docs/app-frictions.md 已更新:
   - Active: N 条(其中 +2 新增)
   - Resolved: M 条(其中 +1 新提升)
   - 总扫描 K 条 LOG entries 来自 P 个 apps
   ```

## Cross-app pattern 识别 heuristics

When deciding if two entries are the same root cause:

- **Same API mentioned**: 强信号 (e.g., 都 mention `CheckpointManager`)
- **Same workaround pattern**: 强信号 (e.g., 都在手包 retry/backoff)
- **Same error code or message**: 强信号
- **Different APIs but same subsystem**: 中信号 — 看是否相关
- **Different subsystems but same DX problem** (e.g., "错误信息缺乏上下文"
  在多个地方出现): 中信号 — 提取共性

If unsure, **mention it as a candidate** but don't assert as cross-app:
```
可能的 cross-app 模式(不确定):
- "API 文档跟实际行为不一致" 在 dogfood 和 coding-agent 都有,但是
  涉及不同 API。要算 cross-app 吗?
```

## Edge cases

- **No app-frictions.md yet, no cross-app patterns**: Don't create empty
  file. Tell user "目前每个 app 的 friction 都是独立的,无 cross-app 模式。
  docs/app-frictions.md 暂不需要创建,等出现 ≥2 个 app 共有的 friction 再说。"

- **Single app exists (only dogfood)**: Cross-app analysis is meaningless
  with one app. Tell user "目前只有 dogfood 一个 app,无法做 cross-app
  分析。等 coding-agent 或 research-collab 启动后再用此命令。"

- **Stale entries (very old, no recent context)**: Mention but don't act.
  "apps/foo/HARNESS_LOG.md 最新条目是 6 个月前。这些算 cross-app 还是
  归档?需要你判断。"

- **Resolved 项目又出现复发**: Mention prominently. "之前 Resolved 的
  '<title>' 在 apps/<x>/HARNESS_LOG.md 又出现了 (entry: ...). 要重新
  转回 Active 吗?"

## Don't

- Don't move items to Resolved without checking the 1-month + 0-recurrence
  rule
- Don't fabricate issue/PR numbers for cross-app entries — leave blank if
  unknown
- Don't merge entries from individual LOGs — the cross-app file is a
  meta-index, not a replacement for individual LOGs
- Don't speculate beyond what the LOG entries say
