# Wave-5E · 信任边界类型化 + 多租户

**状态**: pending · **依赖**: Wave-5D 合入 · **估时**: 1 周

## 目标

把"信任"从字符串约定提升到类型层：branded types + sealed handles + segment-aware 边界 +
租户键结构 + payload 上限 + schema 严格化。

## 范围（Findings）

- **SEC-A05** Tool `additionalProperties` 默认放过 → enforcement
- **SEC-A07** `Message.role` 无 branded type → `TrustedSystemMessage`
- **SEC-A08** Redis memory 无长度限制 + 无租户隔离键 → `tenantId:id` 键结构
- **SEC-A09** BoundaryPolicy substring 前缀 → segment 边界
- **SEC-A10** `Message.send({from})` 不验身份 → sealed `SendHandle` 闭包捕获
- **SEC-A11** `HandoffPayload` 无 size/depth cap → 64 KiB + depth 上限
- **SEC-A16** `injection-detector` 不扫 RAG chunks → `runRagContext(pipeline, chunks[])`
- **SEC-A17** `memory/relay.ts` 写时不 stamp `_version` → 写时总 stamp

## 决策

- 多租户 **in-scope**（已在决策文档确认）
- 接受 Redis 键结构 migration（需要迁移脚本）

## 流程

1. **Light ADR**：
   - 多租户 migration 策略（双写窗口 vs 停机迁移）
   - `TrustedSystemMessage` 的 mint 授权方（host only vs per-session HMAC）
   - `SendHandle` 是否在 orchestrator 注册时一次性给出
2. `task-planner`
3. `team-implementer`×5 并行
4. `security-reviewer` + `red-team-attacker` gate（多租户隔离是红队重点）
5. 验收 + 文档

## 具体任务

### E1 — `TrustedSystemMessage` branded type
- `packages/core/src/core/types.ts`（或 `messages.ts`）
- `Message.role === 'system'` 仅接受 `TrustedSystemMessage`（opaque brand）
- `createTrustedSystemMessage(content, hostSecret)` host-only factory
- session restore 路径验证 brand；无 brand 的 system 消息拒绝或降级为 user

### E2 — Redis 租户键
- `packages/redis/src/index.ts`
- key 从 `memory:{id}` 改为 `memory:{tenantId}:{id}`
- `RedisStoreConfig.tenantId` 必填（默认 `'default'` 但 warn）
- 提供迁移脚本 `pnpm --filter @harness-one/redis migrate-tenant-keys`

### E3 — `content` / `metadata` 长度上限
- `packages/core/src/memory/_schemas.ts`
- `maxContentBytes` (default 1 MiB) + `maxMetadataBytes` (default 16 KiB)
- reserved metadata keys (`tenantId` / `sessionId` 等 system-only)

### E4 — BoundaryPolicy segment 匹配
- `packages/core/src/orchestration/context-boundary.ts`
- 前缀必须以分隔符 (`.` 或 `/`) 结尾；校验时 segment 边界
- `createContextBoundary` 时拒绝无分隔符前缀（抛 `INVALID_CONFIG`）

### E5 — `SendHandle` sealed + `HandoffPayload` cap
- `packages/core/src/orchestration/orchestrator.ts`
- 注册 agent 时发 sealed `SendHandle` 闭包捕获 `from`
- `handoff.send` 签名：`(handle, to, payload)`；禁止 raw `from` 入参
- `serializePayload` 加 64 KiB + 深度 16 的 cap；超限抛 `HANDOFF_PAYLOAD_TOO_LARGE`

### E6 — `additionalProperties` enforcement
- `packages/core/src/_internal/json-schema.ts`（或 Wave-5C 后的 `infra/json-schema.ts`）
- `additionalProperties: false` 从 warning 升为 enforcement
- 缺省时 `safeWarn` 提示建议加

### E7 — RAG chunks 路由
- `packages/core/src/guardrails/pipeline.ts`
- 新增 `runRagContext(pipeline, chunks: string[])`：每 chunk 独立扫；任一命中污染
- `AgentLoop` 整合：`config.ragPipeline?: GuardrailPipeline`；RAG 拼入 context 前调用

### E8 — `memory/relay.ts` 写时 stamp `_version`
- `packages/core/src/memory/relay.ts`
- 所有写路径强制 `_version` stamp；读时缺失视为 v0（兼容旧数据）

## 关键文件

- `packages/core/src/core/messages.ts` or `types.ts`
- `packages/redis/src/index.ts`
- `packages/core/src/memory/_schemas.ts`
- `packages/core/src/orchestration/context-boundary.ts`
- `packages/core/src/orchestration/orchestrator.ts`
- `packages/core/src/orchestration/handoff.ts`
- `packages/core/src/_internal/json-schema.ts`
- `packages/core/src/guardrails/pipeline.ts`
- `packages/core/src/memory/relay.ts`
