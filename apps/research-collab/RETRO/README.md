# RETRO · apps/research-collab

每次 milestone（M0 / M1 / M2 / M3 — 见 DESIGN §2.4）结束时，在这个目录
下新建 `M<N>-YYYY-MM-DD.md`，按以下模板写：

```markdown
# Milestone M<N> retro · YYYY-MM-DD

## 完成的 deliverables
- ...

## HARNESS_LOG 增量
- L-DATE-00X · 一句话摘要 → 主仓库 issue/PR 链接（如已提交）
- ...

## METRICS 实测
- task_success_rate: __%
- mean_cost_usd: $__
- ...（按 METRICS.md §1 顺序）

## 验证的 Open Question
- OQ#__: 决策为 __，依据是 __

## 下个 milestone 的优先项
- ...
```

写完后在主 README 索引里加一行链接，避免 retro 散落难找。

⚠️ DESIGN §6.1 强调："Open Question 没好好答，research-collab 变成
研究质量产品而不是 orchestration 压测 dogfood"。每次 retro 必须 review
本目录里历次 retro 的 OQ 决策有没有偏离 dogfood-first 的方向。
