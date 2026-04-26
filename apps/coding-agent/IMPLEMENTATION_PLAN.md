# `apps/coding-agent` 实施规划

> 落地 [`docs/coding-agent-DESIGN.md`](../../docs/coding-agent-DESIGN.md) 的工程实施 PLAN。本文件追踪 9 个阶段的进度,每个阶段交付物 + 验收清单 + 状态。

## 总览

| Stage | 主题 | 状态 | 交付物 | 验收 |
|---|---|---|---|---|
| **S1** | 包骨架 + 配置 | ✅ done | `package.json` / `tsconfig.json` / `vitest.config.ts` / `eslint.config.js` / 占位 `src/index.ts` / 目录结构 | typecheck 通过、smoke 测试绿 |
| **S2** | 核心类型 + 状态机 | ✅ done | `src/agent/types.ts` / `src/agent/state-machine.ts` | 状态切换合法性单测 21 个全绿;`assertTransition` 抛 `CORE_INVALID_STATE` |
| **S3** | MVP tools | ✅ done | `src/tools/{read_file,write_file,list_dir,grep,shell,run_tests,git_status}.ts` + `paths.ts` + `context.ts` + `registry.ts` | 101/101 单测绿;每个 tool 含 happy + edge + error + abort 用例 |
| **S4** | Guardrails | ✅ done | `src/guardrails/{allowlist,policy,auditor}.ts` | 危险命令拦截、approval flow auto/allowlist/always-ask、命令策略 — 130/130 测试 |
| **S5** | Memory + Checkpoint | ✅ done | `src/memory/{checkpoint,schema,compaction,store}.ts` | InMemory + FsMemoryStore round-trip;corrupt → MEMORY_CORRUPT;flush 策略覆盖 — 162/162 测试 |
| **S6** | Agent core wiring | ✅ done | `src/agent/{index,loop,planner,budget,ids}.ts` | `createCodingAgent` 工厂 + 三维 budget + 状态机持久化 + mock-adapter integration test 跑通 — 182/182 测试 |
| **S7** | CLI | ✅ done | `src/cli/{bin,args,output,signals}.ts` | parseArgs 全 flag 覆盖;SIGINT 二次 force-exit;`harness-coding ls`;help/version/--output 通过 — 215/215 测试 |
| **S8** | Observability + Budget | ✅ done | `src/observability/jsonl-exporter.ts` 接入 `createTraceManager` | jsonl 落盘 + 路径 sanitize;budget 在 S6 已落地 — 222/222 测试 |
| **S9** | Integration + 文档 | ✅ done | `tests/integration/{run-task,full-state-machine,observability,cli}.test.ts` + extra branch coverage suites + `README.md` 重写 + `METRICS.md` + `RETRO/README.md` | 235/235 测试,94% 行覆盖 / 82.5% 分支 — 通过 90/80 门槛 |

---

## 设计原则(贯穿所有阶段)

来自 DESIGN §3.5 / §5,实施时的硬约束:

1. **不重新发明 harness-one** — `AgentLoop` / `ToolRegistry` / `CheckpointManager` / `BudgetManager` / `Logger` / `Redactor` 全用 harness-one,不抄。
2. **Tool 严格遵守** — JsonSchema 输入输出 + idempotent where possible + fail-loud throw + observable + bounded(timeout / allowlist / limit)。
3. **Guardrail 分两类** — Hard(代码层拦截,不可绕过)和 Soft(approval / audit)。
4. **每次状态切换写 checkpoint** — DESIGN §3.7 的写入策略不能省略。
5. **三维 budget 不可超限** — token / iteration / duration,任一超限 graceful abort。
6. **测试覆盖近 100%** — 用户 memory 硬要求,每个 source file 必须有对应 `*.test.ts`。
7. **Workspace deps** — `harness-one` / `@harness-one/anthropic` / `@harness-one/preset` 走 `workspace:*`,与 dogfood 平行。
8. **反哺优先** — 发现 harness-one API 不顺手 → 写 `HARNESS_LOG.md`,不绕开。

---

## 跟 harness-one 子系统的接线点(参考 DESIGN §5)

| 关注点 | harness-one 来源 | 用法 |
|---|---|---|
| Loop | `harness-one/core` `createAgentLoop` | 工厂构造 |
| Tools | `harness-one/tools` `defineTool` / `createRegistry` | 每个 tool 走 `defineTool` |
| Guardrails | `harness-one/guardrails` `createPipeline` | 接进 `inputPipeline` / `outputPipeline` |
| Memory | `harness-one/memory` `createFileSystemStore` | 落 `~/.harness-coding/checkpoints/<taskId>/` |
| Cost | `harness-one/observe` `createCostTracker` | 三维 budget 中的 token 维度 |
| Logger | `harness-one/observe` `createLogger` | 全局结构化日志 + redactor |
| Lifecycle | `@harness-one/preset` `createShutdownHandler` | SIGINT/SIGTERM 干净退出 |
| Adapter | `@harness-one/anthropic` `createAnthropicAdapter` | live 模式 |
| Trace | `harness-one/observe` `createTraceManager` | jsonl exporter |

---

## 失败追踪

每个阶段执行中遇到的 friction 写入 `HARNESS_LOG.md`(在 S9 一并落)。

---

## Phase 2 — 生产级接入与发布

| Stage | 主题 | 状态 | 交付物 | 验收 |
|---|---|---|---|---|
| **S10** | Live Anthropic adapter | ✅ done | `tests/integration/live-anthropic.test.ts` (skipIf no key+`CODING_AGENT_LIVE=1`) + `tests/unit/cli-bin-extra.test.ts` 错误路径 | 237/237 + 1 skipped;adapter 错误传播到 exit code 1 |
| **S11** | Build + 发布 | ✅ done | `tsup.config.ts` / `.changeset/coding-agent-mvp.md` / `package.json` exports → dist / `.npmignore` | `pnpm build` 5 entries + `npm pack` 86KB / 26 files;shebang 保留 |
| **S12** | Eval harness | ✅ done | `src/eval/{runner,verifier,types,index}.ts` + `fixtures/builtin.ts` (3 fixtures) + `harness-coding eval --tag` 子命令 | 256/256 测试;runner+verifier+CLI 全覆盖;`..` 路径拒绝 |
| **S13** | LSP tool | ✅ done | `src/tools/lsp/{client,lsp-tools,index}.ts` + mock LSP server 单测套件 | 265/265 测试;Content-Length JSON-RPC framer + initialize/definition/references/timeout 全覆盖 |
| **S14** | VS Code extension | ✅ done | `apps/coding-agent-vscode/` 完整包(extension.ts + run-task.ts + 配置 + .vscodeignore + README) | tsup 出 `dist/extension.js` (CJS);6 测试覆盖 activate/buildAgent/format/list — vscode-shim 替身 |

## 当前状态

**Active Stage**: complete (S1–S14)
**Phase 1**: complete (S1–S9, 235 测试)
**Phase 2**: complete (S10–S14;coding-agent 265 + vscode 6 = 271 测试)
**Last updated**: 2026-04-26
