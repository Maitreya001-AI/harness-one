# Wave-5A · 安全默认值翻转 — 任务计划

**分支**: `wave-5/production-grade`
**PRD 等价物**: Wave-5A 范围（SEC-A01/A02/A03/A04/A06 + M-9 + `createSecurePreset`）
**决策依据**: `docs/forge-fix/wave-5/decisions.md`

## 任务 DAG (16 原子任务)

| ID | Subject | Files Owned | Depends On | Group | Est min | Risk |
|---|---|---|---|---|---|---|
| T01 | `_internal/safe-log` primitive | `_internal/safe-log.ts`+test; `observe/index.ts` | — | G1 | 25 | low |
| T02 | SEC-A01 logger redaction default-on | `observe/logger.ts`+test | — | G1 | 30 | medium |
| T03 | SEC-A01 trace-manager redaction default-on | `observe/trace-manager.ts`+test | — | G1 | 30 | medium |
| T04 | SEC-A01 langfuse sanitize default-on | `langfuse/src/index.ts`+test | — | G1 | 25 | medium |
| T07 | Error codes: `ADAPTER_INVALID_EXTRA`/`TOOL_CAPABILITY_DENIED`/`PROVIDER_REGISTRY_SEALED` | `core/errors.ts`+test | — | G1 | 15 | low |
| T08 | SEC-A03 tool registry default quotas | `tools/registry.ts`+test | — | G1 | 25 | medium |
| T05 | SEC-A02 anthropic `extra` allow-list | `anthropic/src/index.ts`+test | T01,T07 | G2 | 40 | medium |
| T06 | SEC-A02 openai `extra` allow-list | `openai/src/index.ts`+test | T01,T07 | G2 | 40 | medium |
| T09 | SEC-A03 Tool capability taxonomy + allow-list | `tools/{types,registry,index}.ts`+test | T07,T08 | G3 | 55 | **HIGH** |
| T10 | SEC-A04 AgentLoop guardrail pipeline 挂载 | `core/agent-loop.ts`,`core/errors.ts`(append)+test | T01,T07 | G3 | 70 | **HIGH** |
| T11 | SEC-A06 `sealProviders()` + lazy auto-seal | `openai/src/index.ts`+test | T01,T06,T07 | G4 | 35 | **HIGH** |
| T12 | M-9 anthropic/openai `safeWarn` 统一 | `anthropic/src/index.ts`,`openai/src/index.ts` | T01,T05,T06,T11 | G5 | 25 | low |
| T13 | M-9 ajv/langfuse/redis `safeWarn` 统一 | `ajv/src/index.ts`,`langfuse/src/index.ts`,`redis/src/index.ts` | T01,T04 | G5 | 30 | low |
| T14 | `createSecurePreset()` 工厂 | `preset/src/secure.ts`(new), `preset/src/index.ts`+test | T02,T03,T04,T09,T10,T11 | G6 | 70 | **HIGH** |
| T15 | 文档同步 `docs/architecture/` | `00-overview.md`,`04-tools.md`,`05-guardrails.md`,`06-observe.md` | T02,T03,T04,T08,T09,T10,T11,T14 | G6 | 45 | medium |
| T16 | Changeset + CHANGELOG + build gate | `.changeset/wave-5a-security-defaults.md`,`CHANGELOG.md` | T01-T15 | G7 | 35 | medium |

## 并行批次

- **Wave A (G1)**: T01 T02 T03 T04 T07 T08 — 6 并行
- **Wave B (G2)**: T05 T06 — 2 并行
- **Wave C (G3)**: T09 T10 — 2 并行
- **Wave D (G4)**: T11 — 1 串行
- **Wave E (G5)**: T12 T13 — 2 并行
- **Wave F (G6)**: T14 T15 — 2 并行
- **Wave G (G7)**: T16 — 1 串行收尾

## 关键路径

T07 → T10 → T14 → T15 → T16（6 层深）。T14 是瓶颈。

## HIGH 风险项（需 risk-assessor 复核）

- **T09**: 未声明 capability 的默认 warning vs throw 抉择；影响所有示例 tool
- **T10**: 硬阻断在 streaming 场景的行为；`runToolOutput` vs `runOutput` 语义；与 retry 决策交互
- **T11**: 模块级可变状态并发；`vi.resetModules` 可否绕过
- **T14**: `createDefaultGuardrailPipeline` 成分；`sealProviders` 调用时机；多次 `createSecurePreset` 幂等性

## 红队攻击靶

1. 绕过 logger redaction: child logger / `level: 'debug'` 能否见原值
2. 绕过 capability: 撒谎 `capabilities:['readonly']` 实为 network
3. 绕过 seal: `vi.resetModules`/`require.cache` 清除后重新 register
4. 绕过 extra allow-list: 深嵌套 key（`extra.metadata.user.api_key`）
5. Guardrail ReDoS: `createInjectionDetector` 默认 pattern 在对抗输入下延迟

## 执行门禁

- 每 Wave 跑 `pnpm -r typecheck`
- 断路器：T10 超 2x 预估立即报告 lead
- 最终 gate: `pnpm -r typecheck && pnpm -r lint && pnpm -r test` 全绿 + review-synthesizer APPROVE
