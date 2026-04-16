# Wave-5 恢复入口

**当前状态**（2026-04-16）:
- ✅ **Wave-5A 完成**，分支 `wave-5/production-grade` 已 push 到 origin
- ✅ **Wave-5B 完成**（AgentLoop 3-module decomposition），commits `aa2ce18`（ADR）→ `c94a0e6`（review must-fix）
- ✅ **Wave-5C 主路径完成**（PR-1/PR-2/PR-3 全部 land），commits `18aa594`（PR-1a）→ `f49ff28`（PR-3b）。**T-3.4 placeholder npm publishes 延后至 org-admin token 到位后补一个 PR-3c commit**（R-3.C）。
- ✅ **Wave-5F 完成**（cleanup batch：adapter safeWarn 迁移 + 安全随机 ID + unref timers + preset pricing NaN）。commit `b0b8726`。
- ✅ **Wave-5E 完成**（信任边界类型化 E1-E8）。commit `fa2e0e8`。
- ✅ **Wave-5D 首批完成**（MetricsPort + HarnessLifecycle + in-process AdmissionController）。commit `f5890fc`。**5D.1 延后**：CostTracker 合并、conversation reconciler、Redis-backed TokenBucket、Langfuse 降级为辅 TraceExporter——这四项需要 PRD + ADR 竞争。
- ✅ **Wave-5G 完成**（架构加固 12 项修复）：Circuit Breaker / 统一退避 / 安全随机 ID 补全（TraceManager + AgentPool）/ console.warn → safeWarn / ESLint no-floating-promises / RAG 多租户隔离 / Lifecycle+Metrics 集成 Preset / 优雅关闭 handler / 配置统一校验 / 测试工具扩展 / cache-stability 稳定序列化。

## 分支与 commits

分支: `wave-5/production-grade`
commit 范围: `a6c717b`（main, 0.4.0）→ `HEAD`
- Wave-5A: 18 commits（含 CHANGELOG/README 更新）
- Wave-5B: 6 commits `aa2ce18..c94a0e6`（B0 ADR → B1 callOnce → B2 StreamHandler+AdapterCaller → B3 IterationRunner → B4 run() shrink → B5b review must-fix）

## 待办 Waves（按序执行）

| 顺序 | Wave | 状态 | 简报 | 估时 | 需要决策 |
|---|---|---|---|---|---|
| 1 | **5B** AgentLoop decomposition | ✅ 完成（2026-04-15） | `wave-5b-brief.md` / `wave-5b-adr-v2.md` | — | — |
| 2 | **5C** 包边界 + API 1.0-rc | ✅ 主路径完成（2026-04-15），T-3.4 延后 | `wave-5c-brief.md` / `wave-5c-task-plan.md` | 2-3 周 | PRD + ADR + 包发布决策 |
| 3 | **5D** Observability canonical | ⏳ 待启动 / 部分完成见状态段落 | `wave-5d-brief.md` | 2-3 周 | PRD + ADR + cost 账本归属 |
| 4 | **5E** 信任边界类型化 | ⏳ 待启动 / 部分完成见状态段落 | `wave-5e-brief.md` | 1 周 | Light ADR + 多租户迁移 |
| 5 | **5F** Cleanup | ⏳ 待启动 / 部分完成见状态段落 | `wave-5f-brief.md` | 1 天 | 无 |

## 继续工作的命令

```
"继续 Wave-5C"                    # 启动下一个 wave（PRD + ADR + 包发布）
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
