# Wave-5 决策记录

**日期**: 2026-04-14 · **决策者**: @XRenSiu · **执行分支**: `wave-5/production-grade`

## 不可谈判底线

1. **版本策略**: 走 **1.0-rc 质量** —— 接受 breaking changes，不做向后兼容妥协；0.x → 1.0-rc 过程中允许大刀阔斧重构 API 面、删除 deprecated、收紧默认值。
2. **多租户**: **in-scope** —— Redis 键结构引入 `tenantId:id`、session/memory 存储按 tenant 物理隔离、`TrustedSystemMessage` 和 `SendHandle` 的信任模型必须支持多租户。
3. **Canonical observability**: **OpenTelemetry** 为主，Langfuse 降级为**辅配 exporter**。所有 metric/trace 以 OTel API 为第一方；Langfuse 通过 `TraceExporter` + 可选 `MetricExporter` 桥接。
4. **fail-closed by default**: preset 默认安全 —— redaction on、guardrail pipeline 必填、tool registry 有默认配额、adapter extra 有 allow-list。

## 执行顺序（串行，每 wave 独立 PR）

| # | Wave | 依赖 | PR 目标 |
|---|---|---|---|
| 5A | Security defaults flip | — | `createSecurePreset` + 默认值翻转 |
| 5B | AgentLoop decomposition | 5A | IterationRunner/AdapterCaller/StreamHandler |
| 5C | Package boundaries & API 1.0-rc | 5B | `@harness-one/cli` + `@harness-one/devkit` 分包 + api-extractor gate |
| 5D | Observability + lifecycle + consistency | 5C | `MetricsPort` + 状态机 + 对账器 + `AdmissionController` |
| 5E | Trust boundaries typed | 5D | Branded types + multi-tenant keys |
| 5F | Cleanup (P3 minor) | 5E | 所有 minor 清单 |

## 每 wave 固定流水线

```
[对抗需求/设计 (可选)] → task-planner → risk-assessor
→ team-implementer×N (并行)
→ code-reviewer + security-reviewer + red-team-attacker + spec-reviewer
→ review-synthesizer (裁决 APPROVE 才推进)
→ acceptance-reviewer (需求视角 + 技术视角交叉)
→ doc-updater (同步 docs/architecture/)
→ 合入 wave-5/production-grade
```

## 门禁条件

- 每 wave 必须: typecheck pass + lint pass + test pass + review-synthesizer APPROVE
- 任一 wave 超 2x 预估仍未过门禁 → 断路器触发，停下来报告
- `docs/architecture/` 每次代码变更同步更新（遵循用户 memory 规则）

## 风险与回滚

- 每 wave 独立 commit + 独立可回滚
- 1.0-rc 不发 npm 直到全部 6 wave 通过
- 0.4.x 维护分支在 main，wave-5 在 wave-5/production-grade；紧急 bugfix 可回归 0.4.x
