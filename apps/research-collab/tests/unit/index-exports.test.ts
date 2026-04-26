import { describe, expect, it } from 'vitest';

import * as api from '../../src/index.js';

describe('public surface', () => {
  it('re-exports the canonical entry points', () => {
    expect(typeof api.runResearch).toBe('function');
    expect(typeof api.runPipeline).toBe('function');
    expect(typeof api.buildAgentHarness).toBe('function');
    expect(typeof api.runResearcher).toBe('function');
    expect(typeof api.runSpecialist).toBe('function');
    expect(typeof api.runCoordinator).toBe('function');
    expect(typeof api.defineWebSearchTool).toBe('function');
    expect(typeof api.defineWebFetchTool).toBe('function');
    expect(typeof api.createMockAdapter).toBe('function');
    expect(typeof api.fingerprint).toBe('function');
    expect(typeof api.writeRunReport).toBe('function');
    expect(api.AGENT_ROLES).toEqual(['researcher', 'specialist', 'coordinator']);
    expect(api.BENCHMARK_QUERIES.length).toBeGreaterThan(0);
  });

  it('exports defaults', () => {
    expect(api.DEFAULT_BUDGET_USD).toBeGreaterThan(0);
    expect(api.DEFAULT_MODEL).toBeTruthy();
    expect(api.MAX_SUBQUESTIONS).toBeGreaterThanOrEqual(api.MIN_SUBQUESTIONS);
  });
});
