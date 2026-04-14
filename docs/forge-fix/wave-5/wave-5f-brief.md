# Wave-5F · Cleanup（P3 Minor Batch + 残留）

**状态**: pending · **依赖**: Wave-5E 合入 · **估时**: 1 天

## 目标

一波清扫所有 P3 minor + Wave-5A 遗留的 T12/T13（adapter safeWarn 迁移）+
杂项修复。单 wave team-implementer 批处理，快速合入。

## 范围

### 来自 Wave-5A 的延期任务

- **T12** anthropic + openai 内所有 `console.warn` / `logger ?? console.warn` → `safeWarn`
  - 不改行为，只换调用点
  - 参考 `packages/core/src/_internal/safe-log.ts` 的导出
- **T13** ajv + langfuse + redis 同样迁移

### P3 Minor

- **SEC-A14** `packages/core/src/context/checkpoint.ts:63` `Math.random()` → `prefixedSecureId('cp')`
- **SEC-A15** `packages/core/src/observe/trace-manager.ts:278` sampling 的 `Math.random()` → `crypto.randomInt` 或 `traceId` hash
- **SEC-A17** `packages/core/src/memory/relay.ts` 写时 stamp `_version`（若 Wave-5E 未覆盖）
- **m-1** `try{logger.warn}catch{}` guard-the-guard 模式扩散 7+ 处 → `safeLog` wrapper 封装
- **m-2** `setInterval`/`setTimeout` unref 约定分散 → 集中到 `_internal/timers.ts`（或 `infra/timers.ts`，如 Wave-5C 完成）
  - `unrefTimeout(fn, ms)` / `unrefInterval(fn, ms)` 工具
  - 替换 `tools/registry.ts:213` 超时 timer 未 unref
- **m-3** 空 catch 标注 — 给现存 empty catch（`fs-store.ts:173`、`fs-io.ts:192`、`taste-coding.ts:86,145`、`cli/audit.ts:37,41,77`）统一加注释或走 `safeWarn`
- **m-4** `packages/preset/src/index.ts:282-291` pricing NaN 校验 → `!Number.isFinite || < 0`
- **m-6** `packages/langfuse/src/index.ts` exporter LRU 容量跟随 core `maxTraces`（或订阅 evict 事件）
- **m-7** `docs/architecture/00-overview.md` 行数 / 测试数漂移修正
- **ARCH-10** 残留 — 若 Wave-5C 未删 `eventBus` dead-stub，这里强制删除

## 流程

1. `task-planner` 拆解 ~12 个小任务（大多数是单文件 1-10 行改动）
2. `team-implementer`×3-4 并行批处理（文件冲突少）
3. `code-reviewer` gate
4. 合入

## 验收标准

- 全库 `grep -c "console\.(warn|error)" packages/*/src/*.ts` = 0
  （排除测试 fixture）
- 全库 `grep -c "Math\.random" packages/*/src/**/*.ts` 降到仅剩"非安全相关"用途
- 所有 `setTimeout`/`setInterval` 路径都 unref（查 `grep -n "setTimeout\|setInterval" packages/*/src`）
- 典型 fixture 启动后 `node --tests-only` 能优雅退出（无 hanging timer）
- `docs/architecture/00-overview.md` 的数字和 `wc -l packages/core/src/**/*.ts` 一致
- 3780+ tests 绿

## 关键文件

- `packages/anthropic/src/index.ts`
- `packages/openai/src/index.ts`
- `packages/ajv/src/index.ts`
- `packages/langfuse/src/index.ts`
- `packages/redis/src/index.ts`
- `packages/core/src/context/checkpoint.ts`
- `packages/core/src/observe/trace-manager.ts`
- `packages/core/src/memory/fs-store.ts` / `fs-io.ts` / `relay.ts`
- `packages/core/src/evolve/taste-coding.ts`
- `packages/core/src/cli/audit.ts`
- `packages/preset/src/index.ts`
- 新建: `packages/core/src/_internal/timers.ts`（或 `infra/timers.ts`）
- 新建: `packages/core/src/_internal/safe-log.ts`（补 `safeLog` 包装现有 logger？——或在 T01 已有的基础上扩展）
- `docs/architecture/00-overview.md`（数字修正）

## 风险提示

- 安全相关低；但要注意 T12/T13 的 refactor 必须保证所有 adapter 测试仍绿（曾在 Wave-5A 首次尝试破坏过 40 个测试）
- 先跑全测试基线 → 逐文件改 + 跑对应 package 测试 → 最后全量验证
