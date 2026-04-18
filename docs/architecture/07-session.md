# Session

> 会话管理：TTL 过期、LRU 淘汰、排他锁定、自动 GC。

## 概述

session 模块提供内存级会话管理：通过 `createSessionManager()` 创建管理器，支持 TTL 自动过期、LRU 容量淘汰、会话锁定（排他访问）、定时 GC、生命周期事件回调。设计面向单进程场景，不含持久化。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/session/types.ts` | 类型定义：`Session`、`SessionEvent` | 25 |
| `src/session/manager.ts` | `createSessionManager` 工厂——TTL、LRU、lock、GC、事件总线组合入口 | 472 |
| `src/session/manager-types.ts` | `SessionManager` / `SessionStore` 接口 | 52 |
| `src/session/session-lru.ts` | `unlockedOrder` + `lockedIds` 两结构的 O(1) LRU 淘汰 | 115 |
| `src/session/session-gc.ts` | `setInterval` 定时 GC（使用 `timer.unref()`） | 53 |
| `src/session/session-event-bus.ts` | `emitting` 标志 + `pendingEvents` 队列；`droppedEvents` 计数 | 189 |
| `src/session/conversation-store.ts` | `ConversationStore` + `ConversationStoreCapabilities` 接口 + `createInMemoryConversationStore()` | 223 |
| `src/session/auth.ts` | `AuthContext` + `createAuthContext` + `hasRole` / `hasPermission` | 76 |
| `src/session/index.ts` | 公共导出桶文件 | 17 |

## 公共 API

### 类型定义

| 类型 | 说明 |
|------|------|
| `Session` | 会话：id、createdAt、lastAccessedAt、metadata、status (`active`/`locked`/`expired`) |
| `SessionEvent` | 生命周期事件：type + sessionId + timestamp |

SessionEvent.type 取值：`'created'` | `'accessed'` | `'locked'` | `'unlocked'` | `'expired'` | `'destroyed'`

### 工厂函数

**createSessionManager(config?)**
```ts
function createSessionManager(config?: {
  maxSessions?: number;    // 默认 100
  ttlMs?: number;          // 默认 5 分钟
  gcIntervalMs?: number;   // 默认 60 秒，0 禁用自动 GC
}): SessionManager
```

SessionManager 接口：

| 方法 | 说明 |
|------|------|
| `create(metadata?)` | 创建会话，触发 LRU 淘汰 |
| `get(id)` | 获取会话（不更新 lastAccessedAt，但会检测过期） |
| `access(id)` | 访问会话（更新时间，锁定/过期则抛错） |
| `lock(id)` | 锁定会话，返回 `{ unlock: () => void }` |
| `destroy(id)` | 销毁会话 |
| `list()` | 列出所有会话（同时标记过期的） |
| `gc()` | 手动 GC，返回清除数量 |
| `dispose()` | 清除 GC 定时器 |
| `activeSessions` | 只读，当前活跃会话数（排除过期） |
| `maxSessions` | 只读，最大会话数 |
| `onEvent(handler)` | 注册事件回调 |

## 内部实现

### TTL 过期检测

过期判定：`Date.now() - session.lastAccessedAt > ttlMs`。过期是惰性检测的——在 `get()`、`access()`、`list()` 时检查并标记。`gc()` 则主动扫描全部会话。

### LRU 淘汰

维护**两个**结构而非一个：
- `unlockedOrder: Map<string, true>` — 仅包含可驱逐（unlocked）会话的 LRU 顺序
- `lockedIds: Set<string>` — 仅 membership，无顺序

驱逐时从 `unlockedOrder.keys().next().value` 直接取最旧者——**O(1)**，永远不扫描锁定会话。lock 时从 `unlockedOrder` 移除并加入 `lockedIds`；unlock 时反向。此前实现使用单一 Map 加 while-retry 循环，在全锁定场景会退化为 O(n) 扫描。

**容量检查也 O(1)**：`create()` 时若 `sessions.size >= maxSessions && unlockedOrder.size === 0`，直接抛 `SESSION_LIMIT`，无需 `Array.from(sessions.values()).every(...)` 全扫。

### 排他锁定

`lock(id)` 将 session.status 设为 `'locked'`，返回 unlock 闭包。锁定期间 `access()` 抛出 `SESSION_LOCKED` 错误。`unlock()` 时恢复为 `'active'` 并更新 lastAccessedAt。

### 事件重入保护

emit() 使用 `emitting` 标志和 `pendingEvents` 队列。如果 handler 同步触发新事件（如在 'accessed' handler 中调用 create()），新事件被排队而非递归执行，防止状态损坏。

**事件丢弃可见性（Wave-10 F3）**：当 pendingEvents 队列达到 `MAX_PENDING_EVENTS` 上限时，新事件被丢弃。`droppedEvents` 只读属性（getter）暴露累计丢弃计数，首次丢弃时通过 logger 发出警告（boolean latch 防止日志风暴）。

### 自动 GC

`setInterval` 定时调用 `gc()`。使用 `timer.unref()` 防止阻止 Node.js 进程退出。`dispose()` 清除定时器。

### 不可变返回

所有返回的 Session 对象都是快照（`toReadonly()` 复制 metadata），内部使用 MutableSession。

### Auth Context 深度冻结

会话的 `authContext` 字段通过 `Object.freeze()` 深度冻结后存储。调用方传入的 auth context 对象不可在存储后被外部修改，防止持有引用的调用方意外（或恶意）篡改已验证的认证状态。

## 依赖关系

- **依赖**: `core/errors.ts`（HarnessError）
- **被依赖**: 无直接模块依赖

## 扩展点

- `onEvent()` 回调监听会话生命周期事件，可用于日志或审计
- `metadata` 字段存储自定义会话数据

## 设计决策

1. **惰性过期 + 定时 GC**——惰性检测降低 overhead，定时 GC 防止内存泄漏
2. **lock 返回 unlock 闭包**——鼓励 `try/finally` 模式，防止忘记解锁
3. **unref() GC 定时器**——不阻止进程退出
4. **纯内存实现**——session 模块不依赖 memory 模块，关注点分离

## Wave-8 Production Hardening

1. **ConversationStore.clear()**：`ConversationStore` 接口新增可选的 `clear()` 方法，内存实现 `createInMemoryConversationStore()` 已提供实现，用于清空所有会话的消息历史。
2. **Session list() 重入安全修复**：`list()` 方法现在先收集所有过期会话，再在迭代结束后统一触发过期事件，避免在 Map 迭代过程中因事件回调修改 Map 导致的重入问题。

## 已知限制

- 纯内存实现，进程重启后会话丢失
- 锁是非竞争性的（无等待/排队机制，lock 期间 access 直接抛错）
- LRU 淘汰跳过锁定会话，因此锁定会话不受容量限制约束，极端情况下活跃锁定会话数可超过 maxSessions

## ConversationStore

`ConversationStore` 是 harness-one 的消息历史持久化契约。内存实现由 `createInMemoryConversationStore()` 提供；生产环境应实现该接口并接 Redis/Postgres。

```ts
interface ConversationStore {
  readonly capabilities?: ConversationStoreCapabilities;
  save(sessionId: string, messages: readonly Message[]): Promise<void>;
  load(sessionId: string): Promise<Message[]>;
  append(sessionId: string, message: Message): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
  list(): Promise<string[]>;
  clear?(): Promise<void>;  // Wave-8: 可选，清空所有会话消息历史
}

interface ConversationStoreCapabilities {
  readonly atomicAppend?: boolean;   // append 在并发下原子
  readonly atomicSave?: boolean;     // save 是单事务替换
  readonly atomicDelete?: boolean;
  readonly distributed?: boolean;    // 多进程共享可见
}
```

**约束**：
- `append()` **必须**在并发下原子。内存实现依赖 Node 单线程天然原子；分布式实现需要 Redis `RPUSH` / Postgres `array_append` / 行锁。
- `load()` 返回的数组必须是防御拷贝——调用方的修改不得污染 store。
- 第三方后端应在 `capabilities` 字段如实声明所支持的契约级别，方便调用方做能力检测。

**harness.run() 会话 id**：`harness.run(messages, { sessionId })` 可传入 per-request session id。未传时使用 `'default'` 并在首次发出一次性告警——`"default"` 在多并发 `run()` 场景会让消息互相串扰。
