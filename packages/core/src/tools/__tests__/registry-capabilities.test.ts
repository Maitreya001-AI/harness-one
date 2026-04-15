/**
 * T09: ToolCapability system — registry capability allow-list.
 *
 * Wave-5A strategy: fail-closed defaults + *warning* (not throw) for tools
 * that do not yet declare capabilities. Wave-5C will upgrade unknown/missing
 * capability declarations to hard throws; this test suite locks the
 * Wave-5A contract (warn-only for missing, throw for disallowed).
 */
import { describe, it, expect } from 'vitest';
import { createRegistry, createPermissiveRegistry } from '../registry.js';
import { defineTool } from '../define-tool.js';
import { toolSuccess } from '../types.js';
import {
  ToolCapability,
  ALL_TOOL_CAPABILITIES,
  type ToolCapabilityValue,
} from '../types.js';
import { HarnessError, HarnessErrorCode} from '../../core/errors.js';
import type { Logger } from '../../observe/logger.js';

function makeTool(opts: {
  name?: string;
  capabilities?: readonly ToolCapabilityValue[];
}) {
  return defineTool<{ text: string }>({
    name: opts.name ?? 'echo',
    description: 'echo',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    ...(opts.capabilities !== undefined && { capabilities: opts.capabilities }),
    execute: async (params) => toolSuccess(params.text),
  });
}

function makeRecordingLogger(): { logger: Logger; warnings: Array<{ msg: string; meta?: Record<string, unknown> }> } {
  const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, meta) => warnings.push({ msg, ...(meta !== undefined && { meta }) }),
    error: () => {},
    child: () => logger,
  };
  return { logger, warnings };
}

describe('T09: ToolCapability enumeration', () => {
  it('exposes exactly the 5 documented capability values', () => {
    // Enum shape: `readonly`, `filesystem`, `network`, `shell`, `destructive`.
    const vals = new Set<string>(ALL_TOOL_CAPABILITIES);
    expect(vals.size).toBe(5);
    expect(vals.has('readonly')).toBe(true);
    expect(vals.has('filesystem')).toBe(true);
    expect(vals.has('network')).toBe(true);
    expect(vals.has('shell')).toBe(true);
    expect(vals.has('destructive')).toBe(true);
  });

  it('ToolCapability const object exposes the same values', () => {
    // Allows `ToolCapability.Readonly`-style usage without hand-typing strings.
    const enumVals = new Set(Object.values(ToolCapability));
    expect(enumVals).toEqual(new Set(ALL_TOOL_CAPABILITIES));
  });
});

describe('T09: defineTool accepts capabilities', () => {
  it('accepts a tool declaring capabilities: ["readonly"] without throwing', () => {
    expect(() =>
      makeTool({ capabilities: ['readonly'] }),
    ).not.toThrow();
  });

  it('preserves declared capabilities on the ToolDefinition', () => {
    const tool = makeTool({ capabilities: ['readonly', 'filesystem'] });
    expect(tool.capabilities).toEqual(['readonly', 'filesystem']);
  });
});

describe('T09: createRegistry default allow-list = ["readonly"]', () => {
  it('rejects registration of a tool declaring "shell" capability', () => {
    const registry = createRegistry();
    const tool = makeTool({ name: 'sh', capabilities: ['shell'] });

    let caught: unknown;
    try {
      registry.register(tool);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    const he = caught as HarnessError;
    expect(he.code).toBe(HarnessErrorCode.TOOL_CAPABILITY_DENIED);
    expect(he.message).toMatch(/shell/);
    expect(he.message).toMatch(/sh/);
  });

  it('accepts a tool declaring only ["readonly"] under default allow-list', () => {
    const registry = createRegistry();
    const tool = makeTool({ capabilities: ['readonly'] });
    expect(() => registry.register(tool)).not.toThrow();
  });
});

describe('T09: explicit allowedCapabilities', () => {
  it('allows ["shell"] when registry opts in', () => {
    const registry = createRegistry({
      allowedCapabilities: ['shell', 'readonly'],
    });
    const tool = makeTool({ name: 'sh', capabilities: ['shell'] });
    expect(() => registry.register(tool)).not.toThrow();
  });

  it('still rejects capabilities not in the explicit allow-list', () => {
    const registry = createRegistry({
      allowedCapabilities: ['shell'],
    });
    const tool = makeTool({ name: 'net', capabilities: ['network'] });
    expect(() => registry.register(tool)).toThrow(/TOOL_CAPABILITY_DENIED|network/);
  });
});

describe('T09: tools missing capabilities field — warn, not throw', () => {
  it('registers a tool with no declared capabilities and emits a single safeWarn', () => {
    const { logger, warnings } = makeRecordingLogger();
    const registry = createRegistry({ logger });
    const tool = makeTool({ name: 'legacy' }); // no capabilities

    expect(() => registry.register(tool)).not.toThrow();
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.msg).toMatch(/missing capabilities declaration/i);
    expect(warnings[0]!.msg).toMatch(/1\.0|Wave-5C/i);
    // Meta should identify the offending tool for observability.
    expect(warnings[0]!.meta).toMatchObject({ tool: 'legacy' });
  });

  it('does not emit a warning when capabilities are declared', () => {
    const { logger, warnings } = makeRecordingLogger();
    const registry = createRegistry({ logger });
    registry.register(makeTool({ capabilities: ['readonly'] }));
    expect(warnings.length).toBe(0);
  });
});

describe('T09: createPermissiveRegistry', () => {
  it('allows tools declaring any capability', () => {
    const registry = createPermissiveRegistry();
    const t1 = makeTool({ name: 'fs', capabilities: ['filesystem', 'destructive'] });
    const t2 = makeTool({ name: 'net', capabilities: ['network'] });
    const t3 = makeTool({ name: 'sh', capabilities: ['shell'] });
    expect(() => {
      registry.register(t1);
      registry.register(t2);
      registry.register(t3);
    }).not.toThrow();
  });

  it('still enforces capability presence — unknown/invalid capability strings are denied', () => {
    const registry = createPermissiveRegistry();
    // Cast through unknown because `ToolCapabilityValue` would otherwise reject.
    const tool = makeTool({
      name: 'bogus',
      capabilities: ['telepathy' as unknown as ToolCapabilityValue],
    });
    expect(() => registry.register(tool)).toThrow(/TOOL_CAPABILITY_DENIED|telepathy/);
  });
});

describe('T09: capability check ordered before permission check (INT-09-01)', () => {
  it('a tool that fails both capability and permission reports TOOL_CAPABILITY_DENIED', () => {
    // Permission check never gets a chance: capability check lives at register()
    // time, whereas permission check lives at execute() time. This test asserts
    // the spec-mandated ordering by observing that the register() call itself
    // throws TOOL_CAPABILITY_DENIED rather than the tool reaching execute() and
    // producing a permission error.
    const registry = createRegistry({
      allowedCapabilities: ['readonly'],
      permissions: {
        // Would deny every call at runtime.
        check: () => false,
      },
    });
    const tool = makeTool({ name: 'danger', capabilities: ['destructive'] });

    let caught: unknown;
    try {
      registry.register(tool);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).code).toBe(HarnessErrorCode.TOOL_CAPABILITY_DENIED);
  });
});

describe('T09: TOOL_CAPABILITY_DENIED is a non-retryable config error', () => {
  it('surfaces via HarnessError.code so the classifier can treat it as non-retryable', () => {
    // HarnessError has no `.retryable` field by design — config-time errors
    // are inherently non-retryable. The classifier contract (T07) is that a
    // consumer inspecting `err.code === HarnessErrorCode.TOOL_CAPABILITY_DENIED` must be able
    // to decide "do not retry". We encode that contract here: the error code
    // is stable, and the error does NOT expose a truthy `.retryable`.
    const registry = createRegistry();
    let err: unknown;
    try {
      registry.register(makeTool({ name: 'sh', capabilities: ['shell'] }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarnessError);
    const he = err as HarnessError & { retryable?: boolean };
    expect(he.code).toBe(HarnessErrorCode.TOOL_CAPABILITY_DENIED);
    // Explicitly assert non-retryable semantics.
    expect(he.retryable).not.toBe(true);
  });
});
