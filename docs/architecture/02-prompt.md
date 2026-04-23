# Prompt

> PromptBuilder、PromptRegistry、SkillRegistry、DisclosureManager 四个独立原语。

## 概述

prompt 模块只提供**内容装配机制**，不替用户做工作流决策：

- `createPromptBuilder()` 负责多层 prompt 组装和 KV-cache 稳定前缀
- `createPromptRegistry()` 负责版本化模板存储和变量解析
- `createSkillRegistry()` 负责无状态 skill 内容存储、渲染和静态校验
- `createDisclosureManager()` 负责按 level 渐进展开知识

`SkillRegistry` 是这次架构修正的关键：它只存 markdown / text skill 内容，不跟踪 turn、stage、transition，也不切换工具集。流程判断交给模型，强约束交给 guardrails。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/prompt/builder.ts` | `createPromptBuilder` |
| `src/prompt/registry.ts` | `createPromptRegistry` / `createAsyncPromptRegistry` |
| `src/prompt/skill-types.ts` | `SkillDefinition` / `RenderedSkills` / `SkillValidationResult` / `SkillBackend` |
| `src/prompt/skill-registry.ts` | `createSkillRegistry` / `createAsyncSkillRegistry` |
| `src/prompt/disclosure.ts` | `createDisclosureManager` |
| `src/prompt/index.ts` | 子路径导出桶 |

## 公共 API

### PromptBuilder

```ts
const builder = createPromptBuilder({ separator: '\n\n' });
builder.addLayer({ name: 'system', content: 'You are precise.', priority: 0, cacheable: true });
builder.addLayer({ name: 'task', content: 'Task: {{task}}', priority: 10, cacheable: false });
builder.setVariable('task', 'review this diff');
const assembled = builder.build();
```

### PromptRegistry

```ts
const prompts = createPromptRegistry();
prompts.register({
  id: 'review',
  version: '1.0.0',
  content: 'Review {{snippet}} for {{concern}}',
  variables: ['snippet', 'concern'],
});
const rendered = prompts.resolve('review', {
  snippet: 'function leak() {}',
  concern: 'resource cleanup',
});
```

### SkillRegistry

```ts
const skills = createSkillRegistry();

skills.register({
  id: 'customer_support',
  description: 'Customer support workflow',
  content: `
1. Greet the user.
2. Clarify intent when needed.
3. Use lookup_order for order state and search_kb for policy answers.
4. Escalate to a human if policy requires it.
`.trim(),
  requiredTools: ['lookup_order', 'search_kb', 'escalate_human'],
});

const { content, stableHash } = skills.render(['customer_support']);
const validation = skills.validate(
  ['customer_support'],
  ['lookup_order', 'search_kb', 'escalate_human'],
);
```

`render()` 特性：

- 传入顺序决定基础顺序
- `cacheable: true` 的 skill 会先渲染，方便 system message 前缀命中 KV-cache
- 返回 `stableHash` 便于观测 cache 命中稳定性

`createAsyncSkillRegistry()` 和 PromptRegistry 的 async 版本一致，先查本地缓存，miss 时走 `SkillBackend.fetch()`。

### DisclosureManager

```ts
const disclosure = createDisclosureManager();
disclosure.register('auth', [
  { level: 0, content: 'JWT bearer tokens.' },
  { level: 1, content: 'Refresh via /auth/refresh.' },
]);
```

## 设计决策

1. `SkillRegistry` 无状态。没有 `currentStage` / `processTurn()` / `advanceTo()`。
2. skill 是内容，不是工作流引擎。模型读完整 skill 内容，自行决定下一步。
3. `requiredTools` 只用于静态校验，不影响运行时工具调度。
4. 需要强制前置条件时，用 guardrail 卡在 tool 边界，不用 prompt 状态机“假装强制”。

## 观察模式

如果你还想知道模型当前认为自己处于哪个阶段，不需要 engine 事件回调。直接给模型一个 reporting tool：

```ts
const reportStage = defineTool({
  name: 'report_stage',
  description: 'Report the current stage you are in.',
  parameters: {
    type: 'object',
    properties: {
      stage: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['stage'],
  },
  execute: async ({ stage, reason }) => ({ ok: true, stage, reason }),
});
```

然后在 skill content 里写清楚：“每进入新阶段时，先调用 `report_stage`。”

## 合规约束

硬约束不要放在 skill 内容里实现“阶段切换”。应该放在 guardrail 或 tool policy 上：

```ts
const approvalPrereq = createPipeline({
  input: [{
    name: 'approval_prereq',
    guard: async (ctx) => {
      if (ctx.content.includes('"tool":"approve_loan"') && !sessionState.kycCompleted) {
        return { action: 'block', reason: 'KYC must be completed before approve_loan.' };
      }
      return { action: 'allow' };
    },
  }],
});
```

## 已知限制

- `SkillRegistry` 不负责 skill 选择。选哪个 skill 仍由调用方或模型决定。
- `validate()` 只做静态检查，不会确认工具描述是否足够让模型正确调用。
- `AsyncSkillRegistry.list()` 只反映本地缓存；远端权威列表需要调用方自己预热或单独拉取。
