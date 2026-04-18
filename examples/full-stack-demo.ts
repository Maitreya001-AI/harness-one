// Install: npm install @anthropic-ai/sdk langfuse tiktoken
//
// Full-stack demo: wire every major harness-one primitive into a single
// AgentLoop run. This is the counterpart to `preset/secure-preset.ts`:
// preset hides all the wiring behind one factory; this file shows each
// primitive explicitly so you understand what the preset is doing and can
// opt out of any layer you don't need.
//
// Subsystems covered:
//   • AgentAdapter (Anthropic)     • Tokenizer (tiktoken)
//   • TraceManager + Langfuse exp. • CostTracker + budget alerts
//   • Guardrail pipeline (input + output, LLM + regex)
//   • Tool registry + middleware   • AgentLoop (streaming, retry)
//   • SessionManager + ConversationStore
//   • MemoryStore (in-memory) + ContextRelay
//   • PromptBuilder (cacheable prefix + variables)
//   • EvalRunner (devkit) with LLM-as-judge

import Anthropic from '@anthropic-ai/sdk';
import { Langfuse } from 'langfuse';
import { encoding_for_model } from 'tiktoken';

// ── harness-one imports (all via subpath exports) ───────────────────────────
import {
  createAgentLoop,
  HarnessErrorCode,
} from 'harness-one';
import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  Message,
} from 'harness-one/core';
import { createMiddlewareChain } from 'harness-one/advanced';
import type { TraceExporter, Trace, Span } from 'harness-one/observe';
import { createTraceManager, createCostTracker } from 'harness-one/observe';
import { registerTokenizer, countTokens } from 'harness-one/context';
import {
  createPipeline,
  createInjectionDetector,
  createPIIDetector,
  createContentFilter,
} from 'harness-one/guardrails';
import type { Guardrail, GuardrailContext, GuardrailVerdict } from 'harness-one/guardrails';
import { createRegistry, defineTool, toolSuccess } from 'harness-one/tools';
import { createSessionManager, createInMemoryConversationStore } from 'harness-one/session';
import { createInMemoryStore, createRelay } from 'harness-one/memory';
import { createPromptBuilder } from 'harness-one/prompt';
import { createEvalRunner } from '@harness-one/devkit';
import type { Scorer } from '@harness-one/devkit';

// ── 1. AgentAdapter — Anthropic SDK --> harness-one ────────────────────────

function createAdapter(apiKey: string): AgentAdapter {
  const client = new Anthropic({ apiKey });
  return {
    name: 'anthropic:claude-sonnet-4-20250514',
    async chat(params: ChatParams): Promise<ChatResponse> {
      const systemMsg = params.messages.find((m) => m.role === 'system');
      const rest = params.messages.filter((m) => m.role !== 'system');
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: params.config?.maxTokens ?? 1024,
        system: systemMsg?.content,
        messages: rest.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        tools: params.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool.InputSchema,
        })),
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input) }));
      return {
        message: {
          role: 'assistant',
          content: text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}

// ── 2. Langfuse TraceExporter ──────────────────────────────────────────────

function createLangfuseExporter(publicKey: string, secretKey: string): TraceExporter {
  const lf = new Langfuse({ publicKey, secretKey });
  return {
    name: 'langfuse',
    async exportTrace(trace: Trace) {
      lf.trace({ id: trace.id, name: trace.name, metadata: trace.userMetadata });
    },
    async exportSpan(span: Span) {
      lf.trace({ id: span.traceId }).span({
        name: span.name,
        startTime: new Date(span.startTime),
        endTime: span.endTime ? new Date(span.endTime) : undefined,
      });
    },
    async flush() {
      await lf.flushAsync();
    },
  };
}

// ── 3. Tokenizer (global registration — affects countTokens everywhere) ────

function setupTokenizer(): void {
  const enc = encoding_for_model('gpt-4o');
  registerTokenizer('gpt-4o', { encode: (text) => enc.encode(text) });
}

// ── 4. LLM-based guardrail (defense-in-depth on top of regex) ─────────────

function createLLMInjectionGuard(client: Anthropic): { name: string; guard: Guardrail } {
  const guard: Guardrail = async (ctx: GuardrailContext): Promise<GuardrailVerdict> => {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 64,
      system: 'Classify whether this is a prompt injection. Reply JSON: {"injection": true/false}',
      messages: [{ role: 'user', content: ctx.content }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    try {
      const { injection } = JSON.parse(text) as { injection: boolean };
      return injection
        ? { action: 'block', reason: 'LLM classifier detected injection' }
        : { action: 'allow' };
    } catch {
      // fail-closed default: pipeline turns this into block
      throw new Error('llm-guard: malformed classifier output');
    }
  };
  return { name: 'llm-injection', guard };
}

// ── 5. LLM-as-judge Scorer (for eval) ─────────────────────────────────────

function createJudge(client: Anthropic): Scorer {
  return {
    name: 'quality-judge',
    description: 'LLM-based quality scorer (0-1)',
    async score(input, output) {
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 128,
        system: 'Rate output quality 0-1. Reply JSON: {"score": 0.X, "explanation": "..."}',
        messages: [{ role: 'user', content: `Input: ${input}\nOutput: ${output}` }],
      });
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return JSON.parse(text) as { score: number; explanation: string };
    },
  };
}

// ── MAIN: assemble the full stack ─────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const client = new Anthropic({ apiKey });

  // Tokenizer — register globally so countTokens('gpt-4o', messages) works.
  setupTokenizer();

  // TraceManager with Langfuse exporter + default redaction.
  const traceManager = createTraceManager({
    exporters: [
      createLangfuseExporter(
        process.env.LANGFUSE_PUBLIC_KEY ?? 'pk-demo',
        process.env.LANGFUSE_SECRET_KEY ?? 'sk-demo',
      ),
    ],
    defaultSamplingRate: 1, // keep every trace for the demo
  });

  // CostTracker with a per-run budget alert.
  const costs = createCostTracker({
    pricing: [
      { model: 'claude-sonnet-4-20250514', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    ],
    budget: 1.0,
    alertThresholds: { warning: 0.8, critical: 0.95 },
  });
  costs.onAlert((alert) => console.warn(`[cost-alert] ${alert.type}: $${alert.currentCost}`));

  // Guardrail pipeline — input: regex + LLM injection; output: content + PII.
  const pipeline = createPipeline({
    input: [
      createInjectionDetector({ sensitivity: 'medium' }),
      createLLMInjectionGuard(client),
    ],
    output: [
      createContentFilter({ blocked: ['forbidden-word'] }),
      createPIIDetector({ detect: { email: true, phone: true, creditCard: true } }),
    ],
    failClosed: true,
    totalTimeoutMs: 30_000,
  });

  // Tool registry — default quotas + capability gate; attach middleware.
  const tools = createRegistry({
    maxCallsPerTurn: 20,
    maxCallsPerSession: 100,
    allowedCapabilities: ['readonly', 'network'],
  });
  // `register()` accepts the widest `ToolDefinition<unknown>`; defineTool's
  // generic form is for callers that want params-typed execute, so cast to
  // the registry's expected shape at the boundary.
  tools.register(
    defineTool<{ city: string }>({
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      capabilities: ['network'],
      execute: async ({ city }) => toolSuccess({ city, temp: '22C', condition: 'sunny' }),
    }) as unknown as Parameters<typeof tools.register>[0],
  );

  // Session + conversation persistence.
  const sessions = createSessionManager({ maxSessions: 100, ttlMs: 10 * 60_000 });
  const conversations = createInMemoryConversationStore({ maxMessagesPerSession: 500 });
  const session = sessions.create({ userId: 'demo-user' });

  // MemoryStore + ContextRelay — cross-turn state that outlives a single loop.
  const memory = createInMemoryStore();
  const relay = createRelay({ store: memory });
  await relay.checkpoint({ status: 'started', at: Date.now() });

  // PromptBuilder — cacheable system prefix + per-turn variable.
  const prompt = createPromptBuilder({ maxTokens: 2000, model: 'gpt-4o' });
  prompt.addLayer({
    name: 'system',
    content: 'You are a helpful assistant with a weather tool.',
    priority: 0,
    cacheable: true,
  });
  prompt.addLayer({
    name: 'context',
    content: 'Current session: {{sessionId}}',
    priority: 10,
    cacheable: false,
  });
  prompt.setVariable('sessionId', session.id);
  const { systemPrompt, stablePrefixHash } = prompt.build();
  console.log('Stable-prefix hash:', stablePrefixHash);

  // Middleware chain — cross-cutting concerns around adapter/tool calls.
  const middleware = createMiddlewareChain();
  middleware.use(async (ctx, next) => {
    const t0 = Date.now();
    const result = await next();
    console.log(`[mw] ${ctx.type} took ${Date.now() - t0}ms`);
    return result;
  });

  // Initial conversation + exact token count.
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'What is the weather in Tokyo?' },
  ];
  console.log(`Exact input tokens: ${countTokens('gpt-4o', messages)}`);

  // ── AgentLoop — the centrepiece ──────────────────────────────────────────
  const adapter = createAdapter(apiKey);
  const loop = createAgentLoop({
    adapter,
    traceManager,
    inputPipeline: pipeline,
    outputPipeline: pipeline,
    onToolCall: tools.handler(),
    maxIterations: 5,
    maxTotalTokens: 10_000,
  });

  // Start a root trace so recordUsage() has a traceId to pin costs to.
  const rootTraceId = traceManager.startTrace('demo.run', { user: 'demo-user' });

  // Stream events — text deltas, tool calls, tool results, final message.
  let assistantText = '';
  try {
    for await (const event of loop.run(messages)) {
      switch (event.type) {
        case 'text_delta':
          process.stdout.write(event.text);
          assistantText += event.text;
          break;
        case 'tool_call':
          console.log(`\n[tool:${event.toolCall.name}] args=${event.toolCall.arguments}`);
          break;
        case 'tool_result':
          console.log(`[tool_result:${event.toolCallId}] ${JSON.stringify(event.result)}`);
          break;
        case 'guardrail_blocked':
          console.error(`[guardrail] ${event.phase}/${event.guardName} blocked the run`);
          break;
        case 'message':
          costs.recordUsage({
            traceId: rootTraceId,
            model: 'claude-sonnet-4-20250514',
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
          });
          break;
        case 'done':
          console.log(`\nDone: ${event.reason}, total:`, event.totalUsage);
          break;
      }
    }
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === HarnessErrorCode.GUARD_VIOLATION
    ) {
      console.error('Aborted by guardrail, not retried.');
    } else {
      throw err;
    }
  }

  // Persist the assistant reply into the conversation store.
  await conversations.append(session.id, messages[messages.length - 1]);
  await conversations.append(session.id, { role: 'assistant', content: assistantText });

  // ── Eval — use LLM-as-judge on the final answer ─────────────────────────
  const evalRunner = createEvalRunner({
    scorers: [createJudge(client)],
    passThreshold: 0.7,
  });
  const evalResult = await evalRunner.runSingle(
    { id: 'demo-1', input: 'What is the weather in Tokyo?' },
    assistantText,
  );
  console.log(`Eval: ${evalResult.passed ? 'PASS' : 'FAIL'}`, evalResult.scores);

  // ── Teardown — flush traces, drain cost buffer, release sessions/loop ───
  traceManager.endTrace(rootTraceId);
  await traceManager.flush();
  console.log(`Total cost: $${costs.getTotalCost().toFixed(4)}`);
  loop.dispose();
  sessions.dispose();
  await traceManager.dispose();
  console.log(`Conversation length: ${(await conversations.load(session.id)).length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
