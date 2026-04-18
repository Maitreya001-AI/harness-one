# Evolve

> 持续演进：组件注册与退役条件、漂移检测、品味编码。
> 所在包：`@harness-one/devkit`（**非** core）。

> 架构规则检查器（`createArchitectureChecker` + `noCircularDepsRule` +
> `layerDependencyRule`）**留在 core**，走 `harness-one/evolve-check`
> 子路径；详见 [`16-evolve-check.md`](./16-evolve-check.md)。这里只讨论
> 开发时工具：组件注册、drift 检测、taste-coding。

## 概述

Wave-5C 起，evolve surface 分成两部分：

- **运行时安全保障**（`harness-one/evolve-check`，核心包内）：架构规则
  接口 + 两条内置规则（循环依赖 + 层级边界）。boot 时 / CI 都可用。
- **开发时 workflow**（`@harness-one/devkit`）：组件元数据管理、
  基线偏移检测、taste-coding 规则库。

evolve 模块帮助 Agent 系统适应 LLM 能力的变化：`createComponentRegistry`
追踪每个组件的模型假设和退役条件；`createDriftDetector` 比较基线与当前
值发现偏移；`createTasteCodingRegistry` 将事故教训编码为可执行规则。

导入路径：

```ts
import {
  createComponentRegistry,
  createDriftDetector,
  createTasteCodingRegistry,
} from '@harness-one/devkit';
```

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `packages/devkit/src/evolve/types.ts` | 类型定义：`ComponentMeta`、`DriftReport`、`TasteCodingRule` 等（架构规则类型已移到 `harness-one/evolve-check`） | 63 |
| `packages/devkit/src/evolve/component-registry.ts` | `createComponentRegistry`——组件元数据管理 | 202 |
| `packages/devkit/src/evolve/drift-detector.ts` | `createDriftDetector`——基线偏移检测 | 160 |
| `packages/devkit/src/evolve/taste-coding.ts` | `createTasteCodingRegistry`——品味编码规则管理 | 178 |
| `packages/devkit/src/evolve/index.ts` | 子路径导出桶 | 28 |

## 公共 API

### 类型定义

| 类型 | 说明 |
|------|------|
| `ComponentMeta` | 组件元数据：id、name、description、modelAssumption、retirementCondition (`string \| ((context: Record<string, unknown>) => boolean)`)、createdAt、lastValidated、tags |
| `DriftReport` | 漂移报告：componentId、driftDetected、baseline、current、deviations |
| `DriftDeviation` | 单个偏差：field、expected、actual、severity (low/medium/high) |
| `TasteCodingRule` | 品味编码规则：id、pattern、rule、enforcement (lint/ci/manual)、createdFrom、createdAt |

> **架构规则类型**（`ArchitectureRule` / `RuleContext` / `RuleResult`）现在
> 从 `harness-one/evolve-check` 导入，不再由 devkit 重导出。

### 工厂函数

**createComponentRegistry()**
```ts
function createComponentRegistry(): ComponentRegistry
```

| 方法 | 说明 |
|------|------|
| `register(meta)` | 注册组件（重复 ID 抛错） |
| `get(id)` | 获取组件元数据 |
| `list(filter?)` | 按 tags 过滤列出组件 |
| `validate(id, context?)` | 验证组件假设——评估退役条件 |
| `markValidated(id)` | 更新 lastValidated 时间戳 |
| `getStale(maxAgeDays)` | 获取超过指定天数未验证的组件 |

字符串条件使用简单 DSL（`key operator value`，支持 `>`, `<`, `>=`,
`<=`, `==`, `!=`），并支持 `AND` 子句组合；函数条件直接以 context
对象调用。条件满足时返回 `{ valid: false, reason }`。未提供 context
或无退役条件时返回 valid。

**createDriftDetector(config?)**
```ts
function createDriftDetector(config?: {
  thresholds?: { low: number; medium: number; high: number };  // 默认 0.10 / 0.50 / 1.00
}): DriftDetector
```

| 方法 | 说明 |
|------|------|
| `setBaseline(componentId, baseline)` | 设置基线值 |
| `check(componentId, current)` | 检查当前值与基线的偏差 |
| `checkAll(currentValues)` | 批量检查多个组件 |

**createTasteCodingRegistry()**
```ts
function createTasteCodingRegistry(): TasteCodingRegistry
```

| 方法 | 说明 |
|------|------|
| `addRule(rule)` | 添加规则（重复 ID 抛错） |
| `getRules(filter?)` | 按 enforcement 类型过滤 |
| `removeRule(id)` | 删除规则 |
| `exportRules()` | 导出为 Markdown 格式 |
| `count()` | 规则总数 |
| `check(code)` | 扫描 code 文本，返回 `TasteViolation[]` |
| `getMetrics()` | 返回 `TasteMetrics`：规则数、按 enforcement 分布 |

## 内部实现

### 漂移严重度分类

`DriftDetector.check()` 逐字段对比 baseline 和 current：

- **high**: 字段新增/删除、类型变更、数值偏差 > 50%
- **medium**: 数值偏差 10%-50%、其他值类型不匹配
- **low**: 数值偏差 < 10%

使用内部 `deepEqual()` 递归比较对象和数组。

漂移阈值可通过 `createDriftDetector({ thresholds })` 覆盖默认值。

### 品味编码导出

`exportRules()` 生成标准化 Markdown，每条规则包含 Pattern、Enforcement、Created from、Date 四个字段。

## 依赖关系

- **依赖**: `harness-one/core`（`HarnessError` / `HarnessErrorCode`）
- **被依赖**: 用户代码（devkit 不被任何 L1..L4 包依赖）

## 扩展点

- `ComponentMeta.retirementCondition` 支持字符串 DSL 和函数两种形式
- `DriftDetector` 可用于追踪任意数值指标（延迟、准确率、缓存命中率等）
- `TasteCodingRule.enforcement` 预留 lint/ci/manual 三个执行层级
- 架构规则（循环依赖、层级边界、自定义规则）请看 `harness-one/evolve-check`

## 设计决策

1. **模型假设显式化**——每个组件记录其存在的模型假设和退役条件，为 LLM 能力升级时的组件淘汰提供依据
2. **漂移检测与组件注册分离**——DriftDetector 独立于 ComponentRegistry，可追踪任意指标
3. **品味编码制度化**——将事故教训转化为规则，防止同类问题重复出现
4. **架构规则分离出去**——架构规则是运行时/CI 都需要的硬守卫，和开发时工具分属两类资产；留在 core 包内、走 `harness-one/evolve-check` 子路径即可

## 已知限制

- 字符串退役条件除简单 `key op value` 格式外，现支持 AND 子句；OR 逻辑仍需使用函数形式
- `DriftDetector` 不持久化基线，进程重启后丢失
- `TasteCodingRegistry` 无持久化
