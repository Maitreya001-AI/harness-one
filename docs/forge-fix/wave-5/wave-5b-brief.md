# Wave-5B · AgentLoop Decomposition + 流式错误判别联合

**状态**: pending · **依赖**: Wave-5A 已合入 · **估时**: 2-3 天

## 目标

拆 `packages/core/src/core/agent-loop.ts`（1089 行 / `run()` 450 行 god-method）为三模块：
`IterationRunner` + `AdapterCaller` + `StreamHandler`。消除隐式副通道（实例字段传错误），
清理 deprecated class 拖尾。

## 范围（Findings）

- **C-1** `run()` ~450 行 async generator，内嵌重试 + streaming + hook + 6 处复制 abort 检查
- **M-4** `this._lastStreamErrorCategory` 实例字段副通道（不可并发/不可测）→ 判别联合
- **M-5** `_strategyOptions` 冻结约束暴露到类型层 → `Readonly<>` + closure 捕获
- **M-6** `AgentLoop` class + `createAgentLoop` 工厂双轨（`@deprecated` 仍从 3 入口导出）
- **M-7** `categorizeAdapterError` 私有静态 + 独立 export 重复

## 不能破坏的

- **Wave-5A 的 guardrail hook 点必须在新 `IterationRunner` 中保留**（input/toolOutput/output）
- **Wave-5A 的 `guardrail_blocked` event emit + abortController.abort 语义**
- **Wave-5A 的 `GUARDRAIL_VIOLATION` 非 retryable 分类**

## 流程

1. **Mini-ADR**：`solution-architect` 出 3-模块边界设计 → `technical-critic` 挑战 → 锁定
2. **TDD 拆分**：`issue-fixer` 串行（agent-loop.ts 单文件，不能并行）
   - Step 1: 抽 `AdapterCaller`（adapter 调用 + 重试）
   - Step 2: 抽 `StreamHandler`（流式解析 + 错误分类判别联合；消除 `_lastStreamErrorCategory`）
   - Step 3: 抽 `IterationRunner`（单轮迭代 = 对象；封装 `bailOut(reason)` 私有方法统一 abort/span/event 配对）
   - Step 4: `run()` 简化到 <120 行，只做 orchestration
3. **清理**：删 deprecated `AgentLoop.categorizeAdapterError` 静态方法；工厂不暴露 class 内部
4. **审查门禁**：`code-reviewer` + `red-team-attacker`（streaming cancel / abort 泄漏）

## 验收标准

- `run()` < 120 行
- `handleStream` 返回 `{ ok: true, ... } | { ok: false, errorCategory }` 判别联合
- 无 `_lastStreamErrorCategory` 实例字段
- `ExecutionStrategy.execute` 的 options `Readonly<>` 约束
- Wave-5A 的全部 guardrail 测试仍绿（10 测试）
- 全库 typecheck + 3780+ tests 绿

## 风险提示

- `run()` 是控制流核心；任何分支修改都可能破坏 streaming / tool-call / retry 交互
- 断路器：若 3 倍预估还在红灯，停下来重新设计边界

## 关键文件

- `packages/core/src/core/agent-loop.ts`（主拆分对象）
- `packages/core/src/core/types.ts`（可能需要扩展 `AgentEvent` 或 `ExecutionStrategy`）
- `packages/core/src/core/error-classifier.ts`
- 新建: `packages/core/src/core/iteration-runner.ts` / `adapter-caller.ts` / `stream-handler.ts`
