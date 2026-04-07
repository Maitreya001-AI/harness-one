# Evolve

> 持续演进：组件注册与退役条件、漂移检测、架构规则检查、品味编码。

## 概述

evolve 模块帮助 Agent 系统适应 LLM 能力的变化：ComponentRegistry 追踪每个组件的模型假设和退役条件；DriftDetector 比较基线与当前值发现偏移；ArchitectureChecker 通过可编程规则验证架构约束；TasteCodingRegistry 将事故教训编码为可执行规则。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/evolve/types.ts` | 类型定义：ComponentMeta、DriftReport、ArchitectureRule、TasteCodingRule | ~85 |
| `src/evolve/component-registry.ts` | createComponentRegistry——组件元数据管理 | ~106 |
| `src/evolve/drift-detector.ts` | createDriftDetector——基线偏移检测 | ~122 |
| `src/evolve/architecture-checker.ts` | createArchitectureChecker + noCircularDepsRule + layerDependencyRule | ~172 |
| `src/evolve/taste-coding.ts` | createTasteCodingRegistry——品味编码规则管理 | ~90 |
| `src/evolve/index.ts` | 公共导出桶文件 | ~33 |

## 公共 API

### 类型定义

| 类型 | 说明 |
|------|------|
| `ComponentMeta` | 组件元数据：id、name、description、modelAssumption、retirementCondition、createdAt、lastValidated、tags |
| `DriftReport` | 漂移报告：componentId、driftDetected、baseline、current、deviations |
| `DriftDeviation` | 单个偏差：field、expected、actual、severity (low/medium/high) |
| `ArchitectureRule` | 架构规则：id、name、description、check(context) |
| `RuleContext` | 规则上下文：files、imports |
| `RuleResult` | 规则检查结果：passed、violations |
| `TasteCodingRule` | 品味编码规则：id、pattern、rule、enforcement (lint/ci/manual)、createdFrom、createdAt |

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
| `validate(id)` | 验证组件假设（当前返回 valid） |
| `markValidated(id)` | 更新 lastValidated 时间戳 |
| `getStale(maxAgeDays)` | 获取超过指定天数未验证的组件 |

**createDriftDetector()**
```ts
function createDriftDetector(): DriftDetector
```

| 方法 | 说明 |
|------|------|
| `setBaseline(componentId, baseline)` | 设置基线值 |
| `check(componentId, current)` | 检查当前值与基线的偏差 |
| `checkAll(currentValues)` | 批量检查多个组件 |

**createArchitectureChecker()**
```ts
function createArchitectureChecker(): ArchitectureChecker
```

| 方法 | 说明 |
|------|------|
| `addRule(rule)` | 添加架构规则 |
| `check(context)` | 执行所有规则检查 |
| `listRules()` | 列出已注册规则 |

**内置架构规则**

```ts
function noCircularDepsRule(allowedModules: string[]): ArchitectureRule
function layerDependencyRule(layers: Record<string, string[]>): ArchitectureRule
```

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

## 内部实现

### 漂移严重度分类

DriftDetector.check() 逐字段对比 baseline 和 current：
- **high**: 字段新增/删除、类型变更、数值偏差 > 50%
- **medium**: 数值偏差 10%-50%、其他值类型不匹配
- **low**: 数值偏差 < 10%

使用内部 `deepEqual()` 递归比较对象和数组。

### 循环依赖检测

`noCircularDepsRule` 从 imports 记录构建有向图，对每个模块执行 DFS，通过递归栈检测回边（cycle）。

### 层级依赖规则

`layerDependencyRule` 接收 `{ module: allowedDeps[] }` 映射，检查每个文件的 import 目标是否在允许列表中。模块识别通过路径中包含 `/{module}/` 或以 `{module}/` 开头。

### 品味编码导出

`exportRules()` 生成标准化 Markdown，每条规则包含 Pattern、Enforcement、Created from、Date 四个字段。

## 依赖关系

- **依赖**: `core/errors.ts`（HarnessError）
- **被依赖**: 无直接模块依赖

## 扩展点

- `ComponentMeta.retirementCondition` 和 `modelAssumption` 是自由文本，实际退役检查由用户实现
- 实现 `ArchitectureRule.check` 自定义架构约束
- TasteCodingRule.enforcement 预留 lint/ci/manual 三个执行层级
- DriftDetector 可用于追踪任意数值指标（延迟、准确率、缓存命中率等）

## 设计决策

1. **模型假设显式化**——每个组件记录其存在的模型假设和退役条件，为 LLM 能力升级时的组件淘汰提供依据
2. **漂移检测与组件注册分离**——DriftDetector 独立于 ComponentRegistry，可追踪任意指标
3. **品味编码制度化**——将事故教训转化为规则，防止同类问题重复出现
4. **架构规则可编程**——通过 `check(context)` 函数实现任意架构约束检查

## 已知限制

- ComponentRegistry.validate() 当前不执行实际的退役条件检查，仅返回 valid
- DriftDetector 不持久化基线，进程重启后丢失
- 架构规则的 `getModule()` 基于简单路径字符串匹配，嵌套同名目录可能误判
- TasteCodingRegistry 无持久化
