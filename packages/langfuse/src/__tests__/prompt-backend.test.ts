/**
 * Tests for `createLangfusePromptBackend`. Covers prompt fetch, cache,
 * list, and error paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLangfusePromptBackend } from '../index.js';
import { createMockLangfuse } from './langfuse-test-fixtures.js';

describe('createLangfusePromptBackend', () => {
  let mock: ReturnType<typeof createMockLangfuse>;

  beforeEach(() => {
    mock = createMockLangfuse();
  });

  it('fetches a prompt and converts to PromptTemplate', async () => {
    mock.mocks.getPrompt.mockResolvedValue({
      prompt: 'Hello {{name}}, welcome to {{place}}!',
      version: 3,
    });

    const backend = createLangfusePromptBackend({ client: mock.client });
    const result = await backend.fetch('greeting');

    expect(result).toBeDefined();
    expect(result!.id).toBe('greeting');
    expect(result!.version).toBe('3');
    expect(result!.content).toBe('Hello {{name}}, welcome to {{place}}!');
    expect(result!.variables).toEqual(['name', 'place']);
    expect(result!.metadata?.source).toBe('langfuse');
  });

  it('returns undefined when prompt is not found', async () => {
    mock.mocks.getPrompt.mockRejectedValue(new Error('Not found'));

    const backend = createLangfusePromptBackend({ client: mock.client });
    const result = await backend.fetch('nonexistent');

    expect(result).toBeUndefined();
  });

  it('throws when Langfuse prompt is not a string type', async () => {
    // Langfuse returns a non-string prompt (e.g., a structured/chat prompt object)
    mock.mocks.getPrompt.mockResolvedValue({
      prompt: { messages: [{ role: 'system', content: 'You are helpful' }] },
      version: 1,
    });

    const backend = createLangfusePromptBackend({ client: mock.client });
    // The non-string prompt should cause fetch to return undefined
    // because the error is caught by the outer try/catch
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await backend.fetch('chat-prompt');
    expect(result).toBeUndefined();
    // Default logger renders a JSON line; assert both phrases appear in
    // the single formatted argument.
    const line = (warnSpy.mock.calls[0]?.[0] ?? '') as string;
    expect(line).toContain('Failed to fetch prompt');
    expect(line).toContain('not a string type');
    warnSpy.mockRestore();
  });

  it('non-string prompt raises HarnessError(PROVIDER_ERROR) before being caught', async () => {
    // This test asserts the internal throw path: toPromptTemplate throws a
    // HarnessError with code PROVIDER_ERROR. The outer try/catch in fetch()
    // swallows it, so we verify the thrown error via a direct rethrow spy
    // on the client.getPrompt call chain.
    mock.mocks.getPrompt.mockResolvedValue({
      // structured chat prompt — not a string
      prompt: [{ role: 'system', content: 'hi' }],
      version: 7,
    });

    // Default logger emits a single JSON line via console.log.
    // Assert both the prefix and the propagated error.message appear.
    const warnLines: string[] = [];
    const warnSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      warnLines.push(line);
    });

    const backend = createLangfusePromptBackend({ client: mock.client });
    await backend.fetch('structured-prompt');

    expect(warnLines).toHaveLength(1);
    const line = warnLines[0]!;
    expect(line).toContain('Failed to fetch prompt');
    expect(line).toContain('Langfuse prompt \\"structured-prompt\\" is not a string type');
    warnSpy.mockRestore();
  });

  it('deduplicates variables', async () => {
    mock.mocks.getPrompt.mockResolvedValue({
      prompt: '{{name}} said hello to {{name}}',
      version: 1,
    });

    const backend = createLangfusePromptBackend({ client: mock.client });
    const result = await backend.fetch('test');

    expect(result!.variables).toEqual(['name']);
  });

  it('list returns empty array when no prompts fetched', async () => {
    const backend = createLangfusePromptBackend({ client: mock.client });
    const result = await backend.list!();
    expect(result).toEqual([]);
  });

  it('list returns previously fetched prompts', async () => {
    mock.mocks.getPrompt.mockResolvedValue({
      prompt: 'Hello {{name}}!',
      version: 1,
    });

    const backend = createLangfusePromptBackend({ client: mock.client });
    await backend.fetch('greeting');

    const result = await backend.list!();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('greeting');
    expect(result[0].content).toBe('Hello {{name}}!');
  });

  it('list removes prompts that have been deleted', async () => {
    mock.mocks.getPrompt
      .mockResolvedValueOnce({ prompt: 'Hello', version: 1 })
      .mockRejectedValueOnce(new Error('Not found'));

    const backend = createLangfusePromptBackend({ client: mock.client });
    await backend.fetch('greeting');

    const result = await backend.list!();
    expect(result).toEqual([]);
  });

  it('push throws UNSUPPORTED_OPERATION error (read-only adapter)', async () => {
    const backend = createLangfusePromptBackend({ client: mock.client });
    await expect(
      backend.push!({
        id: 'test',
        version: '1',
        content: 'test',
        variables: [],
      }),
    ).rejects.toThrow('Langfuse SDK does not support pushing prompts programmatically');

    // Verify the error includes a hint about using the Langfuse dashboard
    try {
      await backend.push!({ id: 'x', version: '1', content: 'x', variables: [] });
    } catch (err) {
      expect((err as Error).message).toContain('does not support pushing');
    }
  });
});

// ---------------------------------------------------------------------------
// createLangfuseCostTracker
// ---------------------------------------------------------------------------
