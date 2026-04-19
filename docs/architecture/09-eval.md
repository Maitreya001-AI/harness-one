# Eval

> 评估验证：Runner、Scorer、Generator-Evaluator 分离模式、数据飞轮。
> 所在包：`@harness-one/devkit`（**非** core）。

## 概述

eval / evolve surface 位于 `@harness-one/devkit`（非核心包 `harness-one`），
让核心包保持零运行时依赖、更瘦的 production bundle。
eval 模块提供 Agent 输出质量的评估框架：`createEvalRunner` 将测试用例通过
生成函数和评分器批量评估并产出报告；4 种内置 Scorer（relevance、
faithfulness、length、custom）；`runGeneratorEvaluator` 实现"生成-评估-
反馈-重试"循环；`extractNewCases` 从低分结果自动提取新测试用例。

导入路径：

```ts
import {
  createEvalRunner,
  createRelevanceScorer,
  runGeneratorEvaluator,
  extractNewCases,
} from '@harness-one/devkit';
```

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `packages/devkit/src/eval/types.ts` | 类型定义：`EvalCase`、`EvalResult`、`EvalReport`、`Scorer`、`EvalConfig` 等 | 74 |
| `packages/devkit/src/eval/runner.ts` | `createEvalRunner`——批量评估 + 质量门禁 | 254 |
| `packages/devkit/src/eval/scorers.ts` | 4 种内置评分器工厂 | 190 |
| `packages/devkit/src/eval/generator-evaluator.ts` | `runGeneratorEvaluator`——生成-评估-重试循环 | 93 |
| `packages/devkit/src/eval/flywheel.ts` | `extractNewCases`——低分结果转新用例 | 141 |
| `packages/devkit/src/eval/index.ts` | 子路径导出桶（包 root `@harness-one/devkit` 也 re-export 此桶） | 34 |

## 公共 API

### 类型定义

| 类型 | 说明 |
|------|------|
| `EvalCase` | 评估用例：id、input、expectedOutput?、context?、tags?、metadata? |
| `EvalResult` | 单用例结果：caseId、scores (Record)、passed、details、duration |
| `EvalReport` | 聚合报告：totalCases、passRate、averageScores、results、duration |
| `Scorer` | 评分器接口：name、description、score()、scoreBatch?() |
| `EvalConfig` | Runner 配置：scorers、passThreshold、overallPassRate |
| `GeneratorEvaluatorConfig` | G-E 配置：generate、evaluate、maxRetries |
| `FlywheelConfig` | 飞轮配置：scoreThreshold、maxNewCases |

### 工厂函数

**createEvalRunner(config)**
```ts
function createEvalRunner(config: EvalConfig): EvalRunner
// EvalConfig.passThreshold 默认 0.7（单用例所有 scorer 都需 >= 此值才通过）
// EvalConfig.overallPassRate 默认 0.8（checkGate 的整体通过率门禁）
```

EvalRunner 接口：

| 方法 | 说明 |
|------|------|
| `run(cases, generate)` | 串行运行所有用例，返回 EvalReport |
| `runSingle(evalCase, output)` | 评估单个用例 |
| `checkGate(report)` | 检查报告是否通过质量门禁 |

**内置 Scorer 工厂**

```ts
function createRelevanceScorer(): Scorer      // 输入-输出关键词重叠度
function createFaithfulnessScorer(): Scorer    // 输出在上下文中的扎根率
function createLengthScorer(config: { minTokens?: number; maxTokens?: number }): Scorer
function createCustomScorer(config: { name; description; scoreFn }): Scorer
```

**runGeneratorEvaluator(config, input)**
```ts
function runGeneratorEvaluator(config: GeneratorEvaluatorConfig, input: string):
  Promise<{ output: string; attempts: number; passed: boolean; feedback?: string }>
```

**extractNewCases(report, config)**
```ts
function extractNewCases(report: EvalReport, config: FlywheelConfig): EvalCase[]
```

## 内部实现

### Scorer 评分机制

所有内置 Scorer 基于简单的 tokenize 函数：`text.toLowerCase().split(/\W+/).filter(stopwords)`，去掉 50+ 常见停用词。

- **relevance**: `matchedInputTokens / totalInputTokens`
- **faithfulness**: `groundedOutputTokens / totalOutputTokens`（无 context 时返回 1.0）
- **length**: 在 [min, max] 范围内为 1.0，超出按比例衰减

### Generator-Evaluator 循环

1. 生成：`generate(input)` 或 `generate(input + previousFeedback)`
2. 评估：`evaluate(input, output)` 返回 `{ pass, feedback }`
3. 通过则返回；否则用 feedback 增强 input，重试
4. 达到 maxRetries 返回最后一次输出及 `passed: false`

### 数据飞轮

从 EvalReport 中筛选平均分低于 scoreThreshold 的结果，按平均分升序排列（最差的优先），截取 maxNewCases 个，转化为带 `flywheel` 和 `auto-generated` tag 的新 EvalCase。

生成的 EvalCase ID 使用抗碰撞哈希：`hash(originalCaseId + timestamp + averageScore)`，确保同一用例在不同轮次飞轮运行中生成的 ID 不重复。

### 串行执行

`runner.run()` 串行执行所有用例（`for...of`），有意避免并行以尊重 LLM API 速率限制。

## 依赖关系

- **依赖**: `harness-one/core`（Message 类型、`HarnessError` / `HarnessErrorCode`）
- **被依赖**: 用户代码（devkit 不被任何 L1..L4 包依赖，严格 dev-time）

## 扩展点

- 实现 `Scorer` 接口自定义评分逻辑（如 LLM-as-judge）
- 实现可选的 `scoreBatch?(cases)` 方法支持批量评分（如单次 LLM 调用评估多个用例）
- `createCustomScorer` 接受任意 scoreFn
- `GeneratorEvaluatorConfig.evaluate` 可接入外部评估服务
- 飞轮输出的 EvalCase 可直接回灌到下一轮 `runner.run()`

## 设计决策

1. **Generator 和 Evaluator 分离**——来自 Anthropic 最佳实践："评估比自我批判更容易调优"
2. **scorer 返回 0-1 分数**——标准化接口，便于聚合和比较
3. **质量门禁 (checkGate)**——用于 CI/CD 流水线的 go/no-go 决策
4. **飞轮自动提取**——低分结果直接转为回归测试用例，形成正反馈循环
5. **Dev-time only**——evalclas 依赖（test runner、filesystem）不适合 production bundle；放在 devkit 让核心包保持 zero runtime dep

## 已知限制

- 内置 Scorer 基于关键词匹配，无语义理解能力
- 飞轮生成的 `EvalCase.input` 是原 caseId 而非原始 input（需要用户映射）
- 不支持并行评估
- 无内置的 LLM-as-judge Scorer（需用户通过 `createCustomScorer` 实现）
