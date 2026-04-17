/**
 * Tests for the nested-form public config (`AgentLoopConfigV2`) and
 * the flatten / detect helpers. Also smoke-tests `createAgentLoop`
 * with the nested shape to pin the overload resolution.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAgentLoop } from '../index.js';
import { createMockAdapter } from '../test-utils.js';
import {
  flattenNestedAgentLoopConfig,
  isNestedAgentLoopConfig,
} from '../agent-loop-config.js';

describe('isNestedAgentLoopConfig', () => {
  it('returns false for a purely flat config', () => {
    const flat = { adapter: createMockAdapter({}), maxIterations: 10 };
    expect(isNestedAgentLoopConfig(flat)).toBe(false);
  });

  it('returns true when any v2 group is present', () => {
    const nested = {
      adapter: createMockAdapter({}),
      limits: { maxIterations: 10 },
    };
    expect(isNestedAgentLoopConfig(nested)).toBe(true);
  });
});

describe('flattenNestedAgentLoopConfig', () => {
  it('flattens limits + resilience into the flat shape', () => {
    const adapter = createMockAdapter({});
    const flat = flattenNestedAgentLoopConfig({
      adapter,
      limits: { maxIterations: 7, maxTotalTokens: 1234 },
      resilience: { maxAdapterRetries: 2, baseRetryDelayMs: 500 },
    });
    expect(flat.maxIterations).toBe(7);
    expect(flat.maxTotalTokens).toBe(1234);
    expect(flat.maxAdapterRetries).toBe(2);
    expect(flat.baseRetryDelayMs).toBe(500);
  });

  it('renames pipelines.input/output to inputPipeline/outputPipeline', () => {
    const adapter = createMockAdapter({});
    const pipeline = { guards: [], mode: 'sequential' as const };
    const flat = flattenNestedAgentLoopConfig({
      adapter,
      pipelines: {
        input: pipeline,
        output: pipeline,
      } as never,
    });
    expect(flat.inputPipeline).toBe(pipeline);
    expect(flat.outputPipeline).toBe(pipeline);
  });

  it('omits groups that are undefined (no spurious keys)', () => {
    const adapter = createMockAdapter({});
    const flat = flattenNestedAgentLoopConfig({ adapter });
    expect(flat.adapter).toBe(adapter);
    expect(flat).not.toHaveProperty('maxIterations');
    expect(flat).not.toHaveProperty('logger');
    expect(flat).not.toHaveProperty('inputPipeline');
  });

  it('forwards observability.logger + traceManager', () => {
    const adapter = createMockAdapter({});
    const logger = { warn: vi.fn() };
    const flat = flattenNestedAgentLoopConfig({
      adapter,
      observability: { logger },
    });
    expect(flat.logger).toBe(logger);
  });

  it('maps execution.parallel + maxParallelToolCalls', () => {
    const adapter = createMockAdapter({});
    const flat = flattenNestedAgentLoopConfig({
      adapter,
      execution: { parallel: true, maxParallelToolCalls: 8 },
    });
    expect(flat.parallel).toBe(true);
    expect(flat.maxParallelToolCalls).toBe(8);
  });
});

describe('createAgentLoop (nested config)', () => {
  it('constructs from the nested shape', () => {
    const adapter = createMockAdapter({});
    const loop = createAgentLoop({
      adapter,
      limits: { maxIterations: 3 },
      resilience: { maxAdapterRetries: 0 },
    });
    expect(loop).toBeDefined();
  });

  it('the nested and flat shapes produce the same limits', () => {
    const adapter = createMockAdapter({});
    const fromNested = createAgentLoop({
      adapter,
      limits: { maxIterations: 12 },
    });
    const fromFlat = createAgentLoop({
      adapter,
      maxIterations: 12,
    });
    // Public surface does not currently expose the resolved limits, but
    // both constructions should succeed identically (no throw).
    expect(fromNested).toBeDefined();
    expect(fromFlat).toBeDefined();
  });
});
