# Orchestration — Multi-Agent Infrastructure

> Agent Pool 生命周期管理、Handoff 结构化消息协议、Context Boundary 访问控制。

## 概述

orchestration 模块在已有的 `createOrchestrator()`（Agent 注册、消息路由、委派策略、SharedContext）基础上，新增三个多 Agent 协作原语：

| 工厂函数 | 职责 |
|---------|------|
| `createAgentPool(config)` | AgentLoop 实例的池化生命周期管理 |
| `createHandoff(orchestrator)` | Agent 间结构化消息传递与验收 |
| `createContextBoundary(context, policies?)` | SharedContext 上的 advisory ACL |

三者独立可用，也可与 Orchestrator 组合：Pool 管理 Agent 生命周期，Handoff 管理 Agent 间通信，Boundary 管理 Agent 对共享状态的访问权限。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/orchestration/types.ts` | 类型定义：PoolConfig、HandoffPayload、BoundaryPolicy、MessageTransport、AgentRegistration 等 | ~240 |
| `src/orchestration/agent-pool.ts` | createAgentPool 工厂 | ~217 |
| `src/orchestration/handoff.ts` | createHandoff 工厂 | ~149 |
| `src/orchestration/context-boundary.ts` | createContextBoundary 工厂 | ~143 |
| `src/orchestration/message-queue.ts` | MessageQueue class（从 orchestrator 提取，含背压信号） | ~124 |

## Agent Pool

### 用途

管理可复用的 AgentLoop 实例池。避免频繁创建/销毁 Agent 的开销，支持预热、空闲回收和优雅排空。

### 工厂函数

```ts
function createAgentPool(config: PoolConfig): AgentPool
```

**配置项**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `factory` | `(role?) => AgentLoop` | 必填 | 创建新 AgentLoop 实例的工厂函数 |
| `min` | `number` | `0` | 最小空闲实例数（预热目标） |
| `max` | `number` | `10` | 最大总实例数（硬上限） |
| `idleTimeout` | `number` | `60000` | 空闲 Agent 回收超时（ms） |
| `maxAge` | `number` | — | Agent 最大存活时间（ms），超龄强制回收 |

### API

| 方法 | 说明 |
|------|------|
| `acquire(role?)` | 获取空闲 Agent 或创建新实例。达到 `max` 时抛出 `POOL_EXHAUSTED` |
| `release(agent)` | 归还 Agent 到池中。幂等。超龄 Agent 直接销毁 |
| `resize(target)` | 调整池大小：裁剪空闲 Agent 或预热到目标数 |
| `drain(timeoutMs?)` | 等待所有 active Agent 被归还后销毁全部。默认超时 30s |
| `stats` | 只读属性，返回 `PoolStats`：idle、active、total、created、recycled |
| `dispose()` | 立即销毁所有 Agent 并清理定时器 |

### 设计决策

- **懒预热** —— `min` 数量的 Agent 在首次 `acquire()` 时才创建，而非构造时
- **空闲定时器 unref** —— `setTimeout().unref()` 确保空闲定时器不阻止 Node.js 进程退出
- **超龄回收** —— `acquire()` 和 `release()` 时检查 `maxAge`，超龄 Agent 自动销毁并替换

## Handoff Protocol

### 用途

在 Agent 间传递结构化任务请求，支持附件（artifacts）、关注点（concerns）、验收标准（acceptanceCriteria）。底层通过 Orchestrator 的消息通道路由，上层提供类型安全的信封格式。

### 工厂函数

```ts
function createHandoff(transport: MessageTransport): HandoffManager
```

接受任何实现 `MessageTransport` 接口的对象。`AgentOrchestrator` 天然实现此接口，但也可传入轻量级自定义实现：

```ts
// 使用 Orchestrator（最常见）
const handoff = createHandoff(orch);

// 使用自定义 MessageTransport
const transport: MessageTransport = {
  send(msg) { myChannel.publish(msg); },
};
const handoff = createHandoff(transport);
```

`MessageTransport` 接口定义：

```ts
interface MessageTransport {
  send(message: Omit<AgentMessage, 'timestamp'>): void;
}
```

### API

| 方法 | 说明 |
|------|------|
| `send(from, to, payload)` | 发送结构化 handoff，返回 `HandoffReceipt` |
| `receive(agentId)` | FIFO 接收下一条待处理的 handoff payload |
| `history(agentId)` | 获取涉及该 Agent 的所有 handoff 记录 |
| `verify(receiptId, output, verifier)` | 根据 acceptanceCriteria 验证输出，返回 `{ passed, violations }` |
| `dispose()` | 清空所有 receipt 和 inbox |

### HandoffPayload 结构

```ts
interface HandoffPayload {
  summary: string;                        // 必填：任务摘要
  artifacts?: HandoffArtifact[];          // 附件（type + content + label）
  concerns?: string[];                    // 需要注意的问题
  acceptanceCriteria?: string[];          // 验收标准（供 verify() 使用）
  context?: Record<string, unknown>;      // 额外上下文
  metadata?: Record<string, unknown>;     // 元数据
}
```

### 设计决策

- **JSON 序列化前缀** —— 消息内容以 `__handoff__:` 前缀 + JSON 格式传输，便于接收方区分 handoff 消息与普通消息
- **Receipt 容量上限** —— 默认最多保留 10,000 条 receipt，FIFO 淘汰；可通过 `HandoffConfig.maxReceipts` 自定义
- **Inbox 容量上限** —— 每个 Agent 的 inbox 默认最多 1,000 条，FIFO 淘汰；可通过 `HandoffConfig.maxInboxPerAgent` 自定义
- **不可变返回值** —— receipt 和 payload 均 `Object.freeze()`

## Context Boundary

### 用途

在 SharedContext 上叠加 advisory 访问控制。通过 per-agent policy 定义哪些 key 前缀可读/可写，实现多 Agent 场景下的状态隔离。

### 工厂函数

```ts
function createContextBoundary(
  context: SharedContext,
  policies?: readonly BoundaryPolicy[],
): BoundedContext
```

### API

| 方法 | 说明 |
|------|------|
| `forAgent(agentId)` | 返回该 Agent 的受控 SharedContext 视图（带缓存） |
| `setPolicies(policies)` | 替换全部策略。已缓存的视图动态反映新策略 |
| `getPolicies(agentId)` | 获取指定 Agent 的策略 |
| `getViolations()` | 获取所有访问违规记录（最多 1,000 条，FIFO） |
| `clearAgent(agentId)` | 移除该 Agent 的缓存视图，避免长期运行时视图缓存泄漏 |

### BoundaryPolicy 结构

```ts
interface BoundaryPolicy {
  agent: string;                // Agent ID
  allowRead?: string[];         // 允许读取的 key 前缀
  denyRead?: string[];          // 拒绝读取的 key 前缀
  allowWrite?: string[];        // 允许写入的 key 前缀
  denyWrite?: string[];         // 拒绝写入的 key 前缀
}
```

### 访问控制规则

1. **deny 优先** —— 如果 key 匹配任一 deny 前缀，立即拒绝
2. **无 allow 列表 = 全部允许** —— 未设置 allowRead/allowWrite 时默认开放
3. **前缀匹配** —— 使用 `key.startsWith(prefix)` 匹配
4. **Fail-closed 写入** —— 写入被拒绝时抛出 `BOUNDARY_WRITE_DENIED` 错误
5. **静默拒绝读取** —— 读取被拒绝时返回 `undefined`，不抛错
6. **违规记录** —— 所有拒绝操作记录到 violations 列表

### 设计决策

- **Advisory 而非强制** —— 无 policy 的 Agent 拥有完全访问权限，boundary 是可选的安全层
- **视图缓存** —— `forAgent()` 缓存每个 Agent 的 scoped view，但策略查找是动态的（`setPolicies()` 后立即生效）
- **读/写不对称** —— 读取失败静默返回 undefined（不中断流程），写入失败抛出错误（防止静默数据丢失）

## MessageQueue

`MessageQueue` 从 `orchestrator.ts` 中提取为独立文件，提供带背压信号的有界消息队列：

```ts
import { MessageQueue } from 'harness-one/orchestration';

const mq = new MessageQueue({
  maxQueueSize: 1000,
  onWarning: ({ message, droppedCount }) => console.warn(message),
  onEvent: (event) => metrics.emit(event),
});

mq.createQueue('agent-a');
const accepted = mq.push('agent-a', agentMessage); // 返回 false 时队列满（已 drop-oldest）
const next    = mq.peek('agent-a');                // 查看队首消息但不移除
const msg     = mq.dequeue('agent-a');             // 移除并返回队首消息
const len     = mq.size('agent-a');                // 返回队列当前长度
const messages = mq.getMessages('agent-a', { type: 'request' });
```

**背压策略**：队列满时采用 drop-oldest（淘汰最旧消息），同时通过 `onWarning` 和 `onEvent` 两路回调发出信号，调用方可据此限流或告警。`push()` 的返回值 `boolean` 表示消息是否进入队列（`false` 意味着有旧消息被丢弃）。`maxQueueSize` 必须 >= 1，否则构造时抛出错误。

## 与 Orchestrator 的组合

三个原语与已有 Orchestrator 的典型组合方式：

```ts
import { createOrchestrator } from 'harness-one/orchestration';
import { createAgentPool, createHandoff, createContextBoundary } from 'harness-one/orchestration';

// 1. 创建 Orchestrator（基础设施）
const orch = createOrchestrator();

// 2. 创建 Agent Pool（生命周期）
const pool = createAgentPool({ factory: (role) => new AgentLoop({ adapter }), max: 5 });

// 3. 创建 Handoff（通信）
const handoff = createHandoff(orch);

// 4. 创建 Context Boundary（访问控制）
const boundary = createContextBoundary(orch.context, [
  { agent: 'planner', allowWrite: ['plan.'], denyWrite: ['config.'] },
  { agent: 'worker', allowRead: ['plan.', 'shared.'], denyWrite: ['plan.'] },
]);
```

## 依赖关系

- **依赖**: `core/agent-loop.ts`（AgentLoop 类型）、`core/errors.ts`（HarnessError）、`orchestration/orchestrator.ts`（AgentOrchestrator 接口；Handoff 仅需 MessageTransport）
- **被依赖**: 无直接模块依赖

## 已知限制

- Agent Pool 不支持 Agent 状态持久化（重启后池为空）
- Handoff 的 inbox 和 receipt 存储在内存中，不支持持久化
- Context Boundary 是 advisory 的——直接引用底层 SharedContext 可绕过访问控制
- Handoff 的 verify() 需要用户提供 verifier 回调，不内置语义验证
