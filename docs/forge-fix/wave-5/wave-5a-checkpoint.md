# Wave-5A Checkpoint — 2026-04-14

**状态**: 暂停（rate limit 到 15:00 Asia/Shanghai 重置）
**分支**: `wave-5/production-grade`
**进度**: 11 / 16 tasks ✅ (69%)
**质量**: 全库 9/9 typecheck 绿，3770/3770 tests 绿，14 commits 干净可回滚

## 已落地（按 commit 顺序）

| # | Commit | Task | 内容 |
|---|---|---|---|
| 1 | `9439bc0` | T03a | trace-manager redact-default 测试 |
| 2 | `12c8b2e` | T03b | trace-manager secure-by-default redaction |
| 3 | `3369ba5` | T08 | tool registry 默认配额 (20/100/30s) |
| 4 | `d93a208` | T04 | langfuse exportSpan 默认 sanitize |
| 5 | `427ddca` | T02 | createLogger 默认启用 DEFAULT_SECRET_PATTERN |
| 6 | `2fc1b18` | T01 | `_internal/safe-log` primitive |
| 7 | `7366967` | T07 | 3 个 Wave-5 error codes 注册 |
| 8 | `b338ea0` | — | 决策文档 + 计划 + 评审 archive |
| 9 | `91dc763` | T05 | anthropic LLMConfig.extra allow-list |
| 10 | `d26d0b3` | T06 | openai LLMConfig.extra allow-list |
| 11 | `34e7d3d` | T09 | ToolCapability 分类 + allow-list |
| 12 | `02d926d` | T10 | AgentLoop guardrail pipeline 挂载 |
| 13 | `90a5a0f` | T11 | openai sealProviders + isProvidersSealed |

## 剩余任务（需 rate limit 恢复后继续）

| # | Task | 风险 | 估时 | 备注 |
|---|---|---|---|---|
| T12 | adapter safeWarn 统一（anthropic+openai） | low | 25m | **partial 已回滚**，需重跑 |
| T13 | adapter safeWarn 统一（ajv+langfuse+redis） | low | 30m | 未开始 |
| T14 | `createSecurePreset()` 工厂 | HIGH | 90m | 用户面产品入口；risk-assessor 6 条条件必须纳入 |
| T15 | `docs/architecture/` 同步 | medium | 45m | `04-tools.md` / `05-guardrails.md` / `06-observe.md` / `00-overview.md` |
| T16 | Changeset + CHANGELOG + build gate | medium | 35m | breaking change 记录 + 最终 lint/test 收尾 |

**剩余预估**: ~3.5h active agent work。

## 已落地的**安全价值**（即使停在这里也已获得的）

1. ✅ **SEC-A01** Redaction 默认 on（logger / trace-manager / langfuse 三层）
2. ✅ **SEC-A02** `LLMConfig.extra` allow-list（anthropic + openai）
3. ✅ **SEC-A03** Tool registry 默认配额 + capability taxonomy（fail-closed `['readonly']`）
4. ✅ **SEC-A04** AgentLoop guardrail hook（3 固定点 + hard-block + stream abort + 非 retry）
5. ✅ **SEC-A06** `sealProviders()` + idempotent（无 auto-seal 避免惊讶）
6. ✅ **SEC-A07**（partial）Error code taxonomy 扩展（`ADAPTER_INVALID_EXTRA` / `TOOL_CAPABILITY_DENIED` / `PROVIDER_REGISTRY_SEALED` / `GUARDRAIL_VIOLATION`）

**未落地**:
- M-9（adapter logger fallback 统一）— 审美/一致性问题，无安全影响
- `createSecurePreset()` — **唯一重要遗留**：生产入口未封装；用户仍需手动组装默认值才能拿到 Wave-5A 收益
- 文档 + changeset + 1.0-rc 版本变更说明

## 恢复建议

**恢复时优先顺序**:
1. **T14 先做**（其余可后做） — 把 Wave-5A 拼装为用户可直接 `import { createSecurePreset }` 的单一入口
2. T12 + T13 合并为一个任务批次跑（纯机械替换，可并行）
3. T15 文档 → T16 changeset + 最终 gate

**给 T14 的关键约束**（risk-assessor 已确认）:
- `sealProviders()` 幂等（第二次 no-op；不再抛）
- 默认 guardrail pipeline: `injection` + `content-filter(moderate)`（input），`pii-redact`（output）
- 分档 `guardrails: 'minimal' | 'standard' | 'strict'`
- **拒绝** `guardrails: 'off'`（要关就用 `createHarness`）
- `sealProviders()` 调用时机: adapter 构造完成后、harness return 前

## 经验教训（写入 memory 候选）

- **lint-staged + husky 在并行 agent 场景下会污染 commit**（auto-stage teammate 文件）。解决方式：agent prompt 明确禁止 `git commit`，Lead 统一 commit；或 disable hook
- **T12-style 机械替换 refactor 超 rate limit**——未来类似全包扫描任务应拆小 chunk 或用 Edit 工具直接 Lead 手动做
