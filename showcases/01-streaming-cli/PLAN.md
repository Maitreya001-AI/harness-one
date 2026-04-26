# PLAN · 01-streaming-cli

> Showcase #01:Streaming CLI Chat。
> 形态压力实验,严格按 `harness-one-showcase-method.md` 7 阶段执行。
> 本 PLAN 为起点,实际启动时 cp 到 `showcases/01-streaming-cli/PLAN.md` 后细化。

---

## 1. 一句话场景描述

一个交互式 CLI REPL,用户输入文本 → harness-one AgentLoop 对接真实
Anthropic adapter 流式返回 token-by-token 打印 → 支持 Ctrl+C 优雅中断 →
保持多轮对话,退出时 graceful shutdown。

---

## 2. 形态定位

**主形态**:流式交互产品(代表产品:Cursor chat、Claude.ai web)

**次形态**:多轮对话(session 维度)

**不是**:agentic loop(没有 tools 或多步推理)、批处理、RAG

---

## 3. 压力点清单(8-15 条,每条可观察)

### Streaming 相关

1. AgentLoop 在 streaming 模式下,`text_delta` 事件按字节流连续到达,
   UTF-8 多字节字符不会被截断到边界中间
2. `StreamAggregator` 处理 10+ 万字符的 stream 时,内存占用稳定
   (无线性增长)
3. 流式响应过程中,`maxStreamBytes` 安全阀真的能在超限时切断

### Abort / 中断链路

4. 用户按 Ctrl+C 触发 SIGINT,AgentLoop 的 `AbortSignal.aborted` 在
   < 100ms 内为 true
5. AbortSignal 真的传到底层 Anthropic SDK 取消 in-flight request
   (而不是让请求继续在后台跑完才返回)
6. 中断后再次 prompt,新的 AgentLoop 实例能正常启动(不残留状态)

### Multi-turn / Session

7. 第二轮对话开始时,前一轮的 `usage`、`history` 都正确恢复
8. session 在 30 分钟空闲后被 LRU 驱逐,下次输入触发新 session 创建
9. 多轮对话时 system message 始终保留在历史顶部

### Lifecycle / Graceful shutdown

10. 用户输入 `exit` 或按 Ctrl+D,触发 graceful shutdown:
    a. lifecycle 状态从 `running` → `draining` → `disposed`
    b. trace exporter flush 已写出所有 span
    c. cost tracker 打印总账
    d. 进程 exit code = 0
11. 进程被 SIGTERM 杀死时(模拟 docker stop),也按上面顺序优雅退出
12. shutdown 期间再来 stdin 输入,被 graceful 拒绝(不崩)

### Cost / Observability

13. 每轮结束打印 token usage 和累计 cost,跟 trace span 里的数字一致
14. trace span 串成完整一条:每次 user message 一个 root span,
    含 `iteration_*` 子 span 含 `text_delta` 累计 byte 计数

---

## 4. 涉及的 subsystem

### Primary(主用)

- **core**:AgentLoop streaming 模式 + StreamAggregator + AbortSignal 链路
- **session**:多轮 session 管理 + TTL + LRU
- **observe**:lifecycle 状态机 + traceManager + costTracker

### Secondary(辅用)

- **advanced**:`toSSEStream` / `formatSSE` 如果做 web mode 用得上(本 showcase 不强求)
- **preset**:`createShutdownHandler` 可能用到
- **infra**:unref timers(后台 task 不应阻塞 process exit)

### Explicitly Avoided(明确不用)

- **rag**:不涉及检索
- **tools**:不带工具
- **guardrails**:本 showcase 不验证 guardrail(其他 showcase 主压)
- **memory** / **orchestration** / **prompt** / **context**:都不用

---

## 5. 可观察的成功标准

### 二元 pass/fail(必须有)

- ✅ **PASS**:连续 50 轮对话不挂、不泄漏、最终 graceful shutdown
- ❌ **FAIL**:任何一轮出现 unhandled rejection、内存增长、僵尸进程

### 数值上限

- 单轮平均 wall clock < 10 秒(p95 < 30 秒)
- 50 轮总 token < 200k
- 50 轮总成本 < $0.50
- 每轮内存增长 ΔRSS < 5 MB(50 轮总 < 250 MB,且 GC 后能回落)

### 中断响应

- Ctrl+C 到 abort 生效:< 100ms
- AbortSignal 到 SDK 真停下:< 500ms

### Trace 完整性

- 50 轮共 50 个 root span(每轮 1 个)
- 无 dangling span(所有 span 都正确 end)
- trace exporter flush 后磁盘文件存在且可解析

---

## 6. 明确的非目标

- ❌ 不证明 LLM 答得好(不验证答案质量)
- ❌ 不证明 UX 美观(就是个 readline,不做高级 TUI)
- ❌ 不验证多用户并发(单用户单进程)
- ❌ 不验证跨 provider 切换(只用 Anthropic)
- ❌ 不验证 RAG / tools / guardrails(这些是其他 showcase 的范围)
- ❌ 不做 web 部署(只是 CLI)

---

## 7. 实施 sketch(给 Build 阶段参考)

预期文件结构:

```
showcases/01-streaming-cli/
  src/
    main.ts             # entry,readline loop
    config.ts           # AgentLoop / session / observability 配置
    shutdown.ts         # graceful shutdown handler
    types.ts            # 本地类型
  README.md             # 给读者的说明,最后写
  package.json          # 必要依赖
```

预期依赖:

```json
{
  "dependencies": {
    "harness-one": "workspace:*",
    "@harness-one/anthropic": "workspace:*",
    "@harness-one/preset": "workspace:*"
  }
}
```

预期主流程伪码:

```typescript
import readline from 'node:readline';
import { createSecurePreset } from '@harness-one/preset';
import { createAnthropicAdapter } from '@harness-one/anthropic';

async function main() {
  const adapter = createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY });
  const harness = createSecurePreset({ adapter, /* ... */ });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const shutdownHandler = createShutdownHandler({ harness, exitTimeout: 5000 });
  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);

  for await (const line of rl) {
    if (line === 'exit') break;
    const abortController = new AbortController();
    rl.once('SIGINT', () => abortController.abort());

    try {
      for await (const event of harness.run({
        messages: [{ role: 'user', content: line }],
        signal: abortController.signal,
      })) {
        if (event.type === 'text_delta') process.stdout.write(event.text);
        if (event.type === 'done') console.log('\n');
      }
    } catch (err) {
      console.error('\nerror:', err);
    }
  }

  await shutdownHandler({ reason: 'user_exit' });
}

main();
```

---

## 8. Hypothesis 起点(给 Stage 2 参考)

预期:

✅ **预期顺利**:

- AgentLoop streaming 模式在单测里覆盖了基本 happy path
- Anthropic SDK 的流式 API 跟 harness-one streamAggregator 应该兼容
- session 管理在集成测试里跑通过
- cost tracker 数字正确

⚠️ **担心有问题**:

- AbortSignal 一路传到 Anthropic SDK 的 fetch 那一层是不是真的能取消请求?
  这条链路单测难以模拟,真跑可能暴露问题
- `text_delta` 在 UTF-8 多字节字符边界处的拆分,理论上应该 OK 但生产
  数据有不同情况
- graceful shutdown 跟 readline 的交互,可能存在 stdin/stdout buffering 问题

❓ **完全不知道**:

- 真实 Anthropic SDK 的 reasoning_tokens 字段对 TokenUsage 类型兼容?
- 50 轮对话中如果 session pruning 触发,system message 保留逻辑跟流式
  路径有没有交互 bug
- shutdown 阶段如果 LLM 还在流式返回,中断信号会怎么传

---

## 9. PLAN review checklist(进 Stage 2 前必过)

- [ ] 压力点 14 条,每条可观察 ✓ (8-15 范围内)
- [ ] 二元 pass/fail 标准存在 ✓ (50 轮稳定运行)
- [ ] 形态坐标单一 ✓ (流式 + 多轮,不夹其他)
- [ ] 非目标清晰 ✓
- [ ] Primary subsystem 都有压力点覆盖:
  - core ✓ (压力点 1-6, 14)
  - session ✓ (压力点 7-9)
  - observe ✓ (压力点 10-13)
- [ ] Avoid list 写明,验证形态聚焦
- [ ] 工时预估在 timebox 内(MVP 1-2 天,完整 7 阶段 5-7 天)

---

## 10. 给 reviewer 的关键关注点

如果有人 review 这个 showcase 启动,**最该追问的 3 个问题**:

1. "Ctrl+C 真的传到 SDK 底层" 这一条怎么验证?需要在 SDK 层面看到取消信号,
   不能只看应用层 abort 事件
2. 50 轮对话在 5-7 天内是否能完成?真 API key 一轮平均要多久?
3. 如果 timebox 内只能跑 30 轮稳定,要不要降低标准还是延长 timebox?
   (建议:**降标准不延期**——showcase 价值在于"按时跑完后看观察结果",
   不是凑齐 50 轮)

---

## 11. 启动前 owner 决策清单

- [ ] timebox 拍板:1-2 天 MVP,5-7 天完整 7 阶段
- [ ] budget 拍板:$0.50 上限(50 轮 × 0.01 buffer)
- [ ] 用 Anthropic 还是 OpenAI 作为 adapter?(默认 Anthropic)
- [ ] 50 轮对话内容用什么?(建议:固定 prompt 序列,可复现)
- [ ] cassette 录制方式(从 record 模式跑一次留 jsonl)
