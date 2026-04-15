import { describe, it, expect, vi } from 'vitest';
import { createHarness } from '../index.js';
import type { HarnessConfig } from '../index.js';

// Minimal mock Anthropic client
function createMockAnthropicClient() {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-sonnet-4-20250514',
        role: 'assistant',
        stop_reason: 'end_turn',
        type: 'message',
        id: 'msg_test',
      }),
      stream: vi.fn(),
    },
  } as unknown as HarnessConfig extends { client: infer C } ? C : never;
}

describe('Cross-package integration', () => {
  it('createHarness wires all components together', () => {
    const harness = createHarness({
      provider: 'anthropic',
      client: createMockAnthropicClient() as any,
      model: 'claude-sonnet-4-20250514',
      maxIterations: 5,
      guardrails: {
        injection: true,
        contentFilter: { blocked: ['forbidden'] },
      },
    });

    expect(harness.loop).toBeDefined();
    expect(harness.tools).toBeDefined();
    expect(harness.guardrails).toBeDefined();
    expect(harness.traces).toBeDefined();
    expect(harness.costs).toBeDefined();
    expect(harness.sessions).toBeDefined();
    expect(harness.memory).toBeDefined();
    expect(harness.prompts).toBeDefined();
    expect(harness.eval).toBeDefined();
    // Wave-5C T-1.6: `eventBus` field removed (ARCH-010 deprecation fully landed).
    expect(harness.logger).toBeDefined();
    expect(harness.conversations).toBeDefined();
    expect(harness.middleware).toBeDefined();
    expect(typeof harness.run).toBe('function');
    expect(typeof harness.shutdown).toBe('function');
    expect(typeof harness.drain).toBe('function');
  });

  it('shutdown is idempotent', async () => {
    const harness = createHarness({
      provider: 'anthropic',
      client: createMockAnthropicClient() as any,
    });

    await harness.shutdown();
    await harness.shutdown(); // Should not throw
  });

  it('drain aborts loop and shuts down', async () => {
    const harness = createHarness({
      provider: 'anthropic',
      client: createMockAnthropicClient() as any,
    });

    await harness.drain(1000);
    // After drain, shutdown should be idempotent
    await harness.shutdown();
  });

  it('memory store write and read', async () => {
    const harness = createHarness({
      provider: 'anthropic',
      client: createMockAnthropicClient() as any,
    });

    const entry = await harness.memory.write({
      key: 'test',
      content: 'integration test content',
      grade: 'useful',
    });

    expect(entry.id).toBeDefined();
    const read = await harness.memory.read(entry.id);
    expect(read?.content).toBe('integration test content');
  });

  it('tool registry + execution', async () => {
    const harness = createHarness({
      provider: 'anthropic',
      client: createMockAnthropicClient() as any,
    });

    harness.tools.register({
      name: 'test_tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: { x: { type: 'number' } } },
      execute: async (params) => ({ result: (params as any).x * 2 }),
    });

    const result = await harness.tools.execute({
      id: 'call_1',
      name: 'test_tool',
      arguments: JSON.stringify({ x: 21 }),
    });

    expect(result).toBeDefined();
  });
});
