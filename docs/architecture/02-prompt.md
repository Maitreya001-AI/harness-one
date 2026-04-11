# Prompt

> Prompt 工程：多层组装、模板注册、多阶段工作流、渐进披露。

## 概述

prompt 模块提供四个独立的 Prompt 工程原语：PromptBuilder（多层组装 + KV-cache 优化）、PromptRegistry（版本化模板存储）、SkillEngine（多阶段引导式工作流状态机）、DisclosureManager（按需逐级展开知识）。四者互不依赖，可单独使用。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/prompt/types.ts` | 类型定义：PromptLayer、PromptTemplate、SkillDefinition 等 | ~76 |
| `src/prompt/builder.ts` | createPromptBuilder 工厂——多层 prompt 组装 | ~153 |
| `src/prompt/registry.ts` | createPromptRegistry 工厂——模板版本化存储 | ~107 |
| `src/prompt/skills.ts` | createSkillEngine 工厂——多阶段工作流状态机 | ~234 |
| `src/prompt/disclosure.ts` | createDisclosureManager 工厂——渐进披露 | ~110 |
| `src/prompt/index.ts` | 公共导出桶文件 | ~30 |

## 公共 API

### 类型定义

| 类型 | 说明 |
|------|------|
| `PromptLayer` | 一个 prompt 层：name、content、priority、cacheable |
| `PromptTemplate` | 版本化模板：id、version、content、variables |
| `SkillDefinition` | 多阶段技能定义：stages + initialStage |
| `SkillStage` | 单个阶段：prompt、tools、transitions、maxTurns |
| `StageTransition` | 阶段转换规则：目标 + 条件 |
| `TransitionCondition` | 条件联合：turn_count / keyword / manual / custom |
| `TransitionContext` | 自定义条件的上下文 |
| `AssembledPrompt` | 组装结果：systemPrompt、layers、stablePrefixHash、metadata |
| `PromptBackend` | 远程模板源接口：fetch(id, version?)、list?()、push?() |
| `DisclosureLevel` | 单个披露级别：level、content、trigger |

### 工厂函数

**createPromptBuilder(config?)**
```ts
function createPromptBuilder(config?: {
  separator?: string;    // 默认 '\n\n'
  maxTokens?: number;    // 超限时裁剪非 cacheable 层
  model?: string;
}): PromptBuilder
```
返回的 PromptBuilder 接口：`addLayer()`, `removeLayer()`, `setVariable()`, `build()`, `getStablePrefixHash()`。

**createPromptRegistry()**
```ts
function createPromptRegistry(): PromptRegistry
```
返回：`register()`, `get(id, version?)`, `resolve(id, variables, version?)`, `list()`, `has()`.

`register()` 支持 `sanitize` 选项：启用后，模板内容在存储前经过 HTML/脚本注入清理，防止用户提供的模板内容通过变量注入引入恶意标记。`register()` 同时校验 `version` 字段格式——版本号必须符合 semver（`major.minor.patch`），非法格式抛出 HarnessError。

**createSkillEngine()**
```ts
function createSkillEngine(): SkillEngine
```
返回：`registerSkill()`, `startSkill()`, `getCurrentPrompt()`, `getAvailableTools()`, `processTurn()`, `advanceTo()`, `reset()`, `isComplete()` + 只读属性 `currentStage`, `turnCount`, `stageHistory`.

SkillEngine 支持 `onTransition` 回调（在 `startSkill()` 或 `createSkillEngine()` 的 config 中注册）：每次阶段转换成功后调用，入参为 `{ from: string; to: string; reason: TransitionCondition['type'] }`。用于日志记录、埋点或触发副作用（如通知上层 AgentLoop 切换工具集）。

**createAsyncPromptRegistry(backend)**
```ts
function createAsyncPromptRegistry(backend: PromptBackend): AsyncPromptRegistry
```
异步注册表，本地缓存优先、远程 `PromptBackend` 兜底。返回：`register()`, `get(id, version?)`, `resolve(id, variables, version?)`, `list()`, `has()`, `prefetch(ids)`.

`PromptBackend` 接口允许对接 Langfuse 等远程 prompt 管理服务。本地通过 `register()` 注册的模板始终优先于远程结果。`prefetch()` 可在启动时批量预热缓存。

**createDisclosureManager()**
```ts
function createDisclosureManager(): DisclosureManager
```
返回：`register()`, `getContent(topic, maxLevel?)`, `expand()`, `getCurrentLevel()`, `reset()`, `listTopics()`.

## 内部实现

### KV-Cache 优化排序

PromptBuilder.build() 排序规则：cacheable 层排在前面（稳定前缀），然后按 priority 升序。这确保 LLM 的 KV-cache 前缀尽可能稳定。

超出 maxTokens 时，从最高 priority 数值（最不重要）的非 cacheable 层开始裁剪。

### 变量替换

`{{variable}}` 占位符通过正则 `/\{\{(\w+)\}\}/g` 替换。未提供的变量保留原样。PromptRegistry.resolve() 则对缺失变量抛出 HarnessError。

### 状态机转换

SkillEngine.processTurn() 按 transitions 数组顺序检查条件，首个匹配即触发转换。`manual` 类型仅通过 `advanceTo()` 触发。maxTurns 是安全兜底：超限时自动跳到第一个非 manual 转换目标。

### 注册时条件验证

`registerSkill()` 在注册时验证所有转换条件的合法性：`turn_count` 要求 `count` 为数值，`keyword` 要求 `keywords` 为非空数组，`custom` 要求提供 `check` 函数。未知的条件类型抛出 INVALID_TRANSITION 错误。

### 哈希算法

stablePrefixHash 使用 SHA-256 截断，输出 16 位十六进制字符串（64-bit）。哈希在变量替换之前基于原始模板计算，确保 KV-cache 稳定性。用于追踪 KV-cache 命中率，非密码学用途。

## 依赖关系

- **依赖**: `core/errors.ts`（HarnessError）
- **被依赖**: 无直接模块依赖（用户代码导入使用）

## 扩展点

- 实现 `PromptBackend` 接口对接远程模板服务（如 Langfuse），通过 `createAsyncPromptRegistry(backend)` 注入
- 自定义 `TransitionCondition.custom` 实现任意转换逻辑
- 通过 PromptLayer.metadata 附加自定义元数据
- DisclosureLevel.trigger 字段预留自动触发扩展

## 设计决策

1. **四个独立原语**——Builder、Registry、Skills、Disclosure 互不依赖，避免"上帝对象"
2. **cacheable 层优先排序**——对齐 Anthropic/OpenAI 的 prompt caching 策略
3. **变量替换不抛错（Builder）vs 强制抛错（Registry）**——Builder 面向动态组装场景容忍缺失，Registry 面向模板精确解析

## 已知限制

- token 估算默认使用 ~4 chars/token 启发式，用户可通过 `registerTokenizer()` 注册精确计数器（如 tiktoken）
- SkillEngine 一次只能运行一个技能（单活跃技能）
- PromptRegistry 不支持模板删除或更新（注册即不可变）
