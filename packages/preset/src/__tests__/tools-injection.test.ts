/**
 * Tests for `HarnessConfigBase.tools` registry / allowedCapabilities
 * injection (HARNESS_LOG research-collab L-001 / L-005).
 */
import { describe, it, expect } from 'vitest';
import { createHarness } from '../index.js';
import { validateHarnessConfig } from '../validate-config.js';
import {
  createRegistry,
  defineTool,
  ToolCapability,
  toolSuccess,
} from 'harness-one/tools';
import type { AgentAdapter } from 'harness-one/core';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

const adapter: AgentAdapter = {
  async chat() {
    return { message: { role: 'assistant', content: 'ok' }, usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

describe('HarnessConfigBase.tools — injection point', () => {
  describe('mode (a) — caller-supplied registry', () => {
    it('uses the injected ToolRegistry verbatim', () => {
      const customRegistry = createRegistry({
        maxCallsPerTurn: 99,
        allowedCapabilities: ['readonly', 'network'],
      });
      const networkTool = defineTool({
        name: 'web_call',
        description: 'demo',
        capabilities: [ToolCapability.Network],
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => toolSuccess({ ok: true }),
      });
      // The registry must accept a network-capability tool — proves the
      // injected allowedCapabilities are honoured.
      customRegistry.register(networkTool);

      const harness = createHarness({
        type: 'adapter',
        adapter,
        tools: { registry: customRegistry },
      });

      // The harness exposes the injected registry, not a default one.
      expect(harness.tools).toBe(customRegistry);
    });
  });

  describe('mode (b) — caller-supplied allowedCapabilities', () => {
    it('builds a registry that accepts the extended capability list', () => {
      const harness = createHarness({
        type: 'adapter',
        adapter,
        tools: { allowedCapabilities: ['readonly', 'network'] },
      });

      const networkTool = defineTool({
        name: 'web_call',
        description: 'demo',
        capabilities: [ToolCapability.Network],
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => toolSuccess({ ok: true }),
      });
      // Registering a network-capability tool should NOT throw the
      // TOOL_CAPABILITY_DENIED that fail-closed defaults would raise.
      expect(() => harness.tools.register(networkTool)).not.toThrow();
    });

    it('still rejects capabilities outside the explicit list', () => {
      const harness = createHarness({
        type: 'adapter',
        adapter,
        tools: { allowedCapabilities: ['readonly'] }, // explicit allow only readonly
      });

      const networkTool = defineTool({
        name: 'web_call',
        description: 'demo',
        capabilities: [ToolCapability.Network],
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => toolSuccess({ ok: true }),
      });
      expect(() => harness.tools.register(networkTool)).toThrow();
    });
  });

  describe('mode (c) — default fail-closed registry', () => {
    it('omits the tools field → builds a registry with allowedCapabilities=["readonly"]', () => {
      const harness = createHarness({ type: 'adapter', adapter });
      const networkTool = defineTool({
        name: 'web_call',
        description: 'demo',
        capabilities: [ToolCapability.Network],
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => toolSuccess({ ok: true }),
      });
      expect(() => harness.tools.register(networkTool)).toThrow();
    });
  });

  describe('mutual exclusion validation', () => {
    it('rejects passing both registry AND allowedCapabilities', () => {
      const customRegistry = createRegistry();
      let caught: unknown;
      try {
        validateHarnessConfig({
          type: 'adapter',
          adapter,
          tools: {
            registry: customRegistry,
            allowedCapabilities: ['network'],
          },
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HarnessError);
      expect((caught as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
      expect((caught as HarnessError).message).toContain('mutually exclusive');
    });

    it('rejects non-object tools field', () => {
      let caught: unknown;
      try {
        validateHarnessConfig({
          type: 'adapter',
          adapter,
          tools: 'not-an-object',
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HarnessError);
    });

    it('rejects allowedCapabilities that is not an array', () => {
      let caught: unknown;
      try {
        validateHarnessConfig({
          type: 'adapter',
          adapter,
          tools: { allowedCapabilities: 'readonly' },
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HarnessError);
      expect((caught as HarnessError).message).toContain('array');
    });

    it('accepts a tools field with only registry', () => {
      const customRegistry = createRegistry();
      expect(() =>
        validateHarnessConfig({
          type: 'adapter',
          adapter,
          tools: { registry: customRegistry },
        }),
      ).not.toThrow();
    });

    it('accepts a tools field with only allowedCapabilities', () => {
      expect(() =>
        validateHarnessConfig({
          type: 'adapter',
          adapter,
          tools: { allowedCapabilities: ['readonly', 'network'] },
        }),
      ).not.toThrow();
    });
  });
});
