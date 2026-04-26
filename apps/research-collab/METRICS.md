# METRICS · apps/research-collab

> 反哺信号需要"可度量"才有说服力。这份文档列出 research-collab 每次
> release 必须采集的指标 + 数据来源 + 红线阈值。所有指标都从 `RunReport`
> JSON（`research-reports/runs/<date>/<runId>.json`）和 orchestrator
> event stream 派生 —— 没有外部依赖。
>
> DESIGN §2.3 选择了 dogfood-first 成功标准（OQ2 倾向 B），所以这里的
> 指标偏向**反哺密度**和**生产稳定性**，不偏向"研究质量评分"。

---

## 1. 顶层 KPI

| 名称 | 来源 | 红线 | 备注 |
|---|---|---|---|
| `task_success_rate` | `RunReport.status === 'success'` 比例 | ≥ 95% | benchmark queries 全跑后统计 |
| `mean_cost_usd` | `RunReport.cost.usd` 算术平均 | ≤ $1.00 | OQ2-B 成功标准里的 `<$1/task` |
| `p95_duration_ms` | `RunReport.durationMs` 95 分位 | ≤ 60_000 | 单任务 ≤ 60s |
| `harness_issues_filed` | `HARNESS_LOG.md` 新增条目数 | ≥ 5 / 季度 | 反哺密度（DESIGN §2.3 OQ2-B） |
| `fatal_crash_count` | 100 次跑里 process exit ≠ 0 的次数 | == 0 | OQ2-B 成功标准 |

---

## 2. Per-agent 成本切片

| 名称 | 来源 | 期望 | 备注 |
|---|---|---|---|
| `cost_share_researcher` | `cost.perAgent[role==='researcher']` | < 15% | Researcher 不调工具，应该最便宜 |
| `cost_share_specialists` | `cost.perAgent[role==='specialist']` | 50–80% | 主要工作量 |
| `cost_share_coordinator` | `cost.perAgent[role==='coordinator']` | 10–25% | 综合 step |

⚠️ Coordinator 突然超过 30% 通常意味着某个 Specialist 失败导致提示
膨胀 —— 自动告警。

---

## 3. Pipeline 健康度

| 名称 | 来源 | 期望 | 备注 |
|---|---|---|---|
| `subquestion_count_avg` | `subQuestions.length` | 2.5–3.5 | OQ4 限定 MIN..MAX_SUBQUESTIONS |
| `specialist_failure_rate` | `specialists.filter(s => s.status !== 'success').length / total` | < 10% | per-Specialist 失败 |
| `guardrail_block_rate` | 上同，限定 `status === 'guardrail_blocked'` | < 5% | 真实 web 内容里的 injection 命中率 |
| `parse_error_rate` | 上同，限定 `errorCode === 'PARSE_ERROR'` | < 2% | LLM 输出 schema 漂移 |
| `citation_count_avg` | `report.citationCount` 算术平均 | ≥ 2 | 引用密度低 = 报告偏弱 |

---

## 4. Orchestration 子系统反哺信号（DESIGN §5.1 重点）

| 名称 | 来源 | 阈值 | 反哺到 |
|---|---|---|---|
| `handoff_payload_bytes_p95` | 自 orchestratorEvents 计算 | ≤ 32 KiB | `orchestration/safe-payload.ts` 默认 cap 是 64 KiB；接近一半时就要 review payload schema 是否过宽 |
| `dropped_message_count` | `OrchestratorMetrics.droppedMessages` | == 0 | message-queue overflow → 反哺主仓库 |
| `agent_status_transition_count` | 计 `agent_status_changed` 事件 | < 50 / task | 暴增暗示 retry loop |
| `concurrent_specialist_max` | `DEFAULT_SPECIALIST_CONCURRENCY` 实际触达 | == 配置值 | 验证并发控制确实生效 |

---

## 5. 收集方式

```bash
# 单次跑
RESEARCH_MOCK=1 pnpm --filter @harness-one/research-collab research \
    --benchmark langgraph-vs-mastra

# benchmark 全跑（CI 周日定时任务，类似 dogfood weekly.ts）
for slug in $(jq -r '.[].slug' apps/research-collab/src/config/benchmark-queries.ts | grep -oE '"[^"]+"' | tr -d '"'); do
    pnpm --filter @harness-one/research-collab research --benchmark "$slug"
done

# 聚合（脚本预留位 — 跟 apps/dogfood/src/weekly.ts 同款 pattern）
node tools/research-rollup.mjs research-reports/runs --output research-reports/weekly-$(date +%Y-%U).md
```

聚合脚本 `tools/research-rollup.mjs` 不在 MVP 范围；在 **M3** 阶段
（DESIGN §2.4 时间预算）补齐。`HARNESS_LOG.md` 已经手工承担了"反哺
密度"的人工对账。

---

## 6. 红线告警 → 行为映射

| 红线触发 | 行动 |
|---|---|
| `task_success_rate < 95%` | 暂停下次 release，开 incident |
| `mean_cost_usd > $1.00` | 不阻塞 release，但开 issue（标 `app:research-collab` `cost`） |
| `harness_issues_filed == 0`（连续两个 release） | 严重 — 表示这个 app 没在反哺，OQ2-B 的存在意义被掏空 |
| `dropped_message_count > 0` | 立刻反哺主仓库（标 `subsystem:orchestration` `bug`） |
