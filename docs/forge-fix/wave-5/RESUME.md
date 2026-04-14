# Wave-5 恢复入口

**当前状态**（2026-04-14）:
- ✅ **Wave-5A 完成**，分支 `wave-5/production-grade` 已 push 到 origin
- ⏳ Wave-5B ~ 5F 待启动

## 分支与 commits

分支: `wave-5/production-grade`
commit 范围: `a6c717b`（main, 0.4.0）→ `HEAD`（含 Wave-5A 全部 18 commits + CHANGELOG/README 更新）

## 待办 Waves（按序执行）

| 顺序 | Wave | 简报 | 估时 | 需要决策 |
|---|---|---|---|---|
| 1 | **5B** AgentLoop decomposition | `wave-5b-brief.md` | 2-3 天 | 仅 mini-ADR |
| 2 | **5C** 包边界 + API 1.0-rc | `wave-5c-brief.md` | 2-3 周 | PRD + ADR + 包发布决策 |
| 3 | **5D** Observability canonical | `wave-5d-brief.md` | 2-3 周 | PRD + ADR + cost 账本归属 |
| 4 | **5E** 信任边界类型化 | `wave-5e-brief.md` | 1 周 | Light ADR + 多租户迁移 |
| 5 | **5F** Cleanup | `wave-5f-brief.md` | 1 天 | 无 |

## 继续工作的命令

```
"继续 Wave-5B"                    # 启动下一个 wave（mini-ADR + 拆分）
"Wave-5C 从 PRD 阶段开始"          # 跳过 5B（不推荐）
"先把 Wave-5F 的 T12/T13 补了"     # 清理 Wave-5A 残留
```

## 决策文档引用

- `decisions.md` — 1.0-rc / 多租户 in-scope / OTel canonical / fail-closed 底线
- `wave-5a-plan.md` — Wave-5A 16 任务 DAG（已完成 14/16）
- `wave-5a-checkpoint.md` — Wave-5A 中段快照（rate-limit 时记录）

## 重要约束（跨 wave 不变）

- 不向后兼容：1.0-rc 允许所有 breaking change
- 多租户 in-scope：session/memory 必须按 tenant 物理隔离
- OTel 为 canonical 观测栈，Langfuse 辅配
- fail-closed 默认不可协商
- 每 wave 走 `review-synthesizer` APPROVE 才能推进下一 wave
- 每 wave 独立 PR/commit 可回滚
- 文档同步是硬性要求（用户 memory rule `feedback_update_arch_docs.md`）

## 避坑经验（写在这里免得重复踩）

1. **husky lint-staged 在并行 agent 场景下污染 commit** — agent prompt 必须明确禁止 `git commit` / `git add`，由 Lead 统一 commit
2. **T12 式全包扫描 refactor 容易超 rate limit** — 应拆小 chunk 或 Lead 手动做
3. **ajv 包的 dist 如果没 rebuild，preset typecheck 会失败** — 跨包类型引用时记得 `pnpm -r build`
4. **agent 自做的 reset 会波及他人 commit** — 建议在 agent prompt 里加"不要 reset 任何 commit"
