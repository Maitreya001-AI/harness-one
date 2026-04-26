/**
 * Lock the cross-subpath re-exports added per HARNESS_LOG entries
 * HC-006 / HC-007 / HC-004 / HC-008. These are deliberate ergonomic
 * additions: callers building tool wiring or cost tracking should be
 * able to import from one subpath, not two.
 *
 * The tests are compile-time guarantees — if any of these imports
 * disappear, the test file fails to load and the test framework reports
 * the missing export by name.
 */
import { describe, it, expect } from 'vitest';

// HC-006: ToolSchema re-export from harness-one/tools
import type { ToolSchema, ToolCallRequest, ToolExecutionResult } from '../tools/index.js';

// HC-007: TokenUsage re-export from harness-one/observe
import type { TokenUsage } from '../observe/index.js';

// HC-008: createDefaultLogger from harness-one/observe
import { createDefaultLogger } from '../observe/index.js';

// HC-004: validateMemoryEntry from harness-one/memory
import { validateMemoryEntry } from '../memory/index.js';

describe('cross-subpath re-exports', () => {
  it('ToolSchema is structurally usable from harness-one/tools', () => {
    // Type assertion test — if ToolSchema disappears the import fails.
    const schema: ToolSchema = {
      name: 't',
      description: 'd',
      parameters: { type: 'object', properties: {} },
    };
    expect(schema.name).toBe('t');
  });

  it('ToolCallRequest / ToolExecutionResult are accessible from harness-one/tools', () => {
    const req: ToolCallRequest = { id: '1', name: 'x', arguments: '{}' };
    expect(req.id).toBe('1');
    // ToolExecutionResult is a structural type — the test here is the
    // import succeeds, not the runtime shape.
    const _check: ToolExecutionResult | undefined = undefined;
    expect(_check).toBeUndefined();
  });

  it('TokenUsage is structurally usable from harness-one/observe', () => {
    const usage: TokenUsage = { inputTokens: 1, outputTokens: 2 };
    expect(usage.inputTokens).toBe(1);
  });

  it('createDefaultLogger is callable from harness-one/observe', () => {
    const logger = createDefaultLogger();
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('validateMemoryEntry is callable from harness-one/memory', () => {
    expect(typeof validateMemoryEntry).toBe('function');
  });
});
