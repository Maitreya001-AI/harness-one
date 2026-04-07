# Session

> 会话管理：TTL 过期、LRU 淘汰、排他锁定、自动 GC。

## 概述

session 模块提供内存级会话管理：通过 `createSessionManager()` 创建管理器，支持 TTL 自动过期、LRU 容量淘汰、会话锁定（排他访问）、定时 GC、生命周期事件回调。设计面向单进程场景，不含持久化。

## 文件结构

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `src/session/types.ts` | 类型定义：Session、SessionEvent | ~22 |
| `src/session/manager.ts` | createSessionManager 工厂 | ~271 |
| `src/session/index.ts` | 公共导出桶文件 | ~9 |

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

维护 `accessOrder` 数组。`create()` 和 `access()` 时将 session ID 移到末尾。超过 `maxSessions` 时从头部开始淘汰。

### 排他锁定

`lock(id)` 将 session.status 设为 `'locked'`，返回 unlock 闭包。锁定期间 `access()` 抛出 `SESSION_LOCKED` 错误。`unlock()` 时恢复为 `'active'` 并更新 lastAccessedAt。

### 自动 GC

`setInterval` 定时调用 `gc()`。使用 `timer.unref()` 防止阻止 Node.js 进程退出。`dispose()` 清除定时器。

### 不可变返回

所有返回的 Session 对象都是快照（`toReadonly()` 复制 metadata），内部使用 MutableSession。

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

## 已知限制

- 纯内存实现，进程重启后会话丢失
- 锁是非竞争性的（无等待/排队机制，lock 期间 access 直接抛错）
- LRU 淘汰不区分锁定状态（锁定的会话也可能被淘汰）
- 事件回调无 off/unsubscribe 机制
