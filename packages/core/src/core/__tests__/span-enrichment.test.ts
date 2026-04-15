/**
 * Verifies that AgentLoop iteration/tool spans carry the diagnostic attributes
 * a production operator needs to debug incidents:
 * - iteration span: iteration index, adapter name, conversationLength, toolCount, streaming
 * - adapter retry: recorded as a span event with attempt/errorCategory
 * - tool span: toolName + toolCallId attributes, errorMessage on failure
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../agent-loop.js';
import { createTraceManager } from '../../observe/trace-manager.js';
import type { AgentAdapter } from '../types.js';

function makeAdapter(overrides?: Partial<AgentAdapter>): AgentAdapter {
  return {
    name: 'test-adapter',
    async chat() {
      return {
        message: { role: 'assistant', content: 'done' },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    ...overrides,
  };
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
   
  for await (const _ of gen) { /* consume */ }
}

describe('AgentLoop span enrichment', () => {
  it('iteration span carries iteration index, adapter name, conversationLength, streaming', async () => {
    const tm = createTraceManager();
    const loop = new AgentLoop({
      adapter: makeAdapter(),
      traceManager: tm,
    });
    await drain(loop.run([{ role: 'user', content: 'hi' }]));

    // Find the trace (there should be exactly one)
    const activeSpans = tm.getActiveSpans(-1);
    // All iteration spans should be closed by now; walk the trace
    const traceIds = new Set(activeSpans.map(s => s.traceId));
    // Alt: since spans are closed, check via observability API by iterating — but
    // trace-manager stores traces after endTrace until LRU evicts.
    // Use the internal getTrace to find iteration spans.
    // We rely on at least one trace having an iteration-0 span with proper attrs.
    let foundEnriched = false;
    // Try a few synthetic trace IDs; better — hook in via an exporter
    void traceIds;

    // Re-run with an exporter that captures spans
    const spans: Array<{ name: string; attrs: Record<string, unknown> }> = [];
    const capturing = createTraceManager({
      exporters: [{
        name: 'capture',
        exportTrace: async () => {},
        exportSpan: async (span) => { spans.push({ name: span.name, attrs: span.attributes }); },
        flush: async () => {},
      }],
    });
    const loop2 = new AgentLoop({ adapter: makeAdapter(), traceManager: capturing });
    await drain(loop2.run([{ role: 'user', content: 'hi' }]));
    await capturing.flush();

    const iterSpan = spans.find(s => s.name === 'iteration-1');
    expect(iterSpan).toBeDefined();
    expect(iterSpan!.attrs).toMatchObject({
      iteration: 1,
      adapter: 'test-adapter',
      streaming: false,
    });
    expect(iterSpan!.attrs.conversationLength).toBeTypeOf('number');
    expect(iterSpan!.attrs.toolCount).toBe(0);
    expect(iterSpan!.attrs.inputTokens).toBe(10);
    expect(iterSpan!.attrs.outputTokens).toBe(5);
    foundEnriched = true;
    expect(foundEnriched).toBe(true);
    await capturing.dispose();
  });

  it('adapter retry event recorded with attempt and errorCategory', async () => {
    let calls = 0;
    const adapter = makeAdapter({
      async chat() {
        calls++;
        if (calls === 1) {
          const err: Error & { status?: number } = new Error('rate limited');
          err.status = 429;
          throw err;
        }
        return {
          message: { role: 'assistant', content: 'ok' },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    const spans: Array<{ name: string; events: Array<{ name: string; attributes?: Record<string, unknown> }> }> = [];
    const tm = createTraceManager({
      exporters: [{
        name: 'capture',
        exportTrace: async () => {},
        exportSpan: async (span) => { spans.push({ name: span.name, events: [...span.events] }); },
        flush: async () => {},
      }],
    });

    const loop = new AgentLoop({ adapter, traceManager: tm, maxAdapterRetries: 2 });
    await drain(loop.run([{ role: 'user', content: 'hi' }]));
    await tm.flush();

    const iterSpan = spans.find(s => s.name === 'iteration-1');
    expect(iterSpan).toBeDefined();
    const retry = iterSpan!.events.find(e => e.name === 'adapter_retry');
    expect(retry).toBeDefined();
    // attempt is the retry index (0 = first retry, i.e. 2nd chat call)
    expect(retry!.attributes?.attempt).toBeTypeOf('number');
    expect(retry!.attributes?.errorCategory).toBeDefined();
    await tm.dispose();
  });

  // Wave-5B Step 2 gating test (ADR §7 Step 2 / critic §3 / edit #3):
  // the chat-path `adapter_retry` span event must carry the original
  // throw's message as an `error` attribute, sliced to ≤500 chars. This
  // guards the contract at docs/architecture/01-core.md:161 — operators
  // rely on the preview for triage without needing to enable logger
  // capture. The asymmetry with the streaming path is intentional
  // (ADR §2.1): StreamResult only carries the already-wrapped error,
  // so `errorPreview` is omitted on stream retries.
  it('adapter retry event on CHAT path carries `error` attribute (string, ≤500 chars)', async () => {
    let calls = 0;
    // A deliberately long message so we can verify the 500-char slice.
    const longMessage = 'rate limited: ' + 'x'.repeat(800);
    const adapter = makeAdapter({
      async chat() {
        calls++;
        if (calls === 1) {
          const err: Error & { status?: number } = new Error(longMessage);
          err.status = 429;
          throw err;
        }
        return {
          message: { role: 'assistant', content: 'ok' },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    const spans: Array<{ name: string; events: Array<{ name: string; attributes?: Record<string, unknown> }> }> = [];
    const tm = createTraceManager({
      exporters: [{
        name: 'capture',
        exportTrace: async () => {},
        exportSpan: async (span) => { spans.push({ name: span.name, events: [...span.events] }); },
        flush: async () => {},
      }],
    });

    const loop = new AgentLoop({ adapter, traceManager: tm, maxAdapterRetries: 1 });
    await drain(loop.run([{ role: 'user', content: 'hi' }]));
    await tm.flush();

    const iterSpan = spans.find(s => s.name === 'iteration-1');
    expect(iterSpan).toBeDefined();
    const retry = iterSpan!.events.find(e => e.name === 'adapter_retry');
    expect(retry).toBeDefined();
    expect(retry!.attributes?.path).toBe('chat');

    const errAttr = retry!.attributes?.error;
    expect(errAttr).toBeDefined();
    expect(typeof errAttr).toBe('string');
    // Preview must be sliced to ≤500 chars regardless of source length.
    expect((errAttr as string).length).toBeLessThanOrEqual(500);
    // And must preserve the leading content so operators can recognise it.
    expect(errAttr as string).toContain('rate limited');
    await tm.dispose();
  });

  it('tool span carries toolName + toolCallId attributes and errorMessage on failure', async () => {
    const adapter: AgentAdapter = {
      name: 'test-adapter',
      async chat({ messages }) {
        // First call: request tool; second call (after tool result): finish.
        const hasToolResult = messages.some(m => m.role === 'tool');
        if (hasToolResult) {
          return {
            message: { role: 'assistant', content: 'done' },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc-1', name: 'mytool', arguments: '{}' }],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const spans: Array<{ name: string; attrs: Record<string, unknown>; status: string }> = [];
    const tm = createTraceManager({
      exporters: [{
        name: 'capture',
        exportTrace: async () => {},
        exportSpan: async (span) => { spans.push({ name: span.name, attrs: span.attributes, status: span.status }); },
        flush: async () => {},
      }],
    });

    const loop = new AgentLoop({
      adapter,
      traceManager: tm,
      onToolCall: async () => { throw new Error('tool boom'); },
    });
    await drain(loop.run([{ role: 'user', content: 'hi' }]));
    await tm.flush();

    const toolSpan = spans.find(s => s.name === 'tool:mytool');
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attrs.toolName).toBe('mytool');
    expect(toolSpan!.attrs.toolCallId).toBe('tc-1');
    expect(toolSpan!.status).toBe('error');
    expect(String(toolSpan!.attrs.errorMessage)).toContain('tool boom');
    await tm.dispose();
  });
});
