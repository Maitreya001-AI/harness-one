# Eval

> 评估验证：Runner、Scorer、Generator-Evaluator 分离模式、数据飞轮。

## 概述

eval 模块提供 Agent 输出质量的评估框架：EvalRunner 将测试用例通过生成函数和评分器批量评估并产出报告；4 种内置 Scorer（relevance、faithfulness、length、custom）；Generator-Evaluator 分离模式实现生成-评估-反馈-重试循环；数据飞轮从低分结果自动提取新测试用例。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/eval/types.ts` | 类型定义：EvalCase、EvalResult、EvalReport、Scorer、EvalConfig 等 | ~69 |
| `src/eval/runner.ts` | createEvalRunner——批量评估 + 质量门禁 | ~112 |
| `src/eval/scorers.ts` | 4 种内置评分器工厂 | ~160 |
| `src/eval/generator-evaluator.ts` | runGeneratorEvaluator——生成-评估-重试循环 | ~73 |
| `src/eval/flywheel.ts` | extractNewCases——低分结果转新用例 | ~60 |
| `src/eval/index.ts` | 公共导出桶文件 | ~35 |

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

### 串行执行

`runner.run()` 串行执行所有用例（`for...of`），有意避免并行以尊重 LLM API 速率限制。

## 依赖关系

- **依赖**: `core/errors.ts`（HarnessError）
- **被依赖**: 无直接模块依赖

## 扩展点

- 实现 `Scorer` 接口自定义评分逻辑（如 LLM-as-judge）
- 实现可选的 `scoreBatch?(cases)` 方法，支持批量评分（如单次 LLM 调用评估多个用例）。签名：`scoreBatch?(cases: Array<{ input, output, context? }>): Promise<Array<{ score, explanation }>>`
- `createCustomScorer` 接受任意 scoreFn
- `GeneratorEvaluatorConfig.evaluate` 可接入外部评估服务
- 飞轮输出的 EvalCase 可直接回灌到下一轮 runner.run()

## 设计决策

1. **Generator 和 Evaluator 分离**——来自 Anthropic 最佳实践："评估比自我批判更容易调优"
2. **scorer 返回 0-1 分数**——标准化接口，便于聚合和比较
3. **质量门禁 (checkGate)**——用于 CI/CD 流水线的 go/no-go 决策
4. **飞轮自动提取**——低分结果直接转为回归测试用例，形成正反馈循环

## 已知限制

- 内置 Scorer 基于关键词匹配，无语义理解能力
- 飞轮生成的 EvalCase.input 是原 caseId 而非原始 input（需要用户映射）
- 不支持并行评估
- 无内置的 LLM-as-judge Scorer（需用户通过 createCustomScorer 实现）
