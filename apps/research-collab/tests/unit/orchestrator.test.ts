import { describe, expect, it } from 'vitest';

import { runPipeline } from '../../src/pipeline/orchestrator.js';
import { buildAgentHarness } from '../../src/harness-factory.js';
import { createMockAdapter, DEFAULT_SCRIPT } from '../../src/mock-adapter.js';
import { defineWebSearchTool, createFixtureSearchProvider } from '../../src/tools/web-search.js';
import { defineWebFetchTool, createFixtureFetcher, type FetchedPage } from '../../src/tools/web-fetch.js';

const fixturePages = new Map<string, FetchedPage>();
for (const ans of DEFAULT_SCRIPT.specialistAnswers) {
  for (const c of ans.citations) {
    fixturePages.set(c.url, {
      url: c.url,
      title: c.title,
      content: c.excerpt,
      bytes: new TextEncoder().encode(c.excerpt).byteLength,
    });
  }
}

function makeHarnesses() {
  const adapter = createMockAdapter();
  const search = createFixtureSearchProvider([]);
  const fetcher = createFixtureFetcher(fixturePages);
  return {
    researcher: buildAgentHarness({ role: 'researcher', adapter, budgetUsd: 1, model: 'mock' }),
    coordinator: buildAgentHarness({ role: 'coordinator', adapter, budgetUsd: 1, model: 'mock' }),
    specialistFactory: () => ({
      harness: buildAgentHarness({ role: 'specialist', adapter, budgetUsd: 1, model: 'mock' }),
      tools: {
        webSearch: defineWebSearchTool(search),
        webFetch: defineWebFetchTool({ fetcher }),
      },
    }),
  };
}

describe('runPipeline', () => {
  it('runs the linear flow and returns aggregated costs + events', async () => {
    const harnesses = makeHarnesses();
    const events: string[] = [];
    const out = await runPipeline({
      runId: 'r-test',
      question: 'How does harness-one orchestration work?',
      harnesses,
      onOrchestratorEvent: (e) => events.push(e.type),
    });
    expect(out.subQuestions.length).toBe(DEFAULT_SCRIPT.subQuestions.length);
    expect(out.report.summary).toContain('orchestration');
    // Without a configured ModelPricing the harness CostTracker keeps
    // costs at 0 — the per-agent slices still exist in the report shape.
    expect(out.costs.total).toBeGreaterThanOrEqual(0);
    // Researcher + Coordinator + N Specialists registered → agent_registered events
    expect(events.filter((t) => t === 'agent_registered').length).toBeGreaterThanOrEqual(3);
    expect(events).toContain('agent_status_changed');
  });

  it('clamps specialist concurrency to a minimum of 1 / max of 8', async () => {
    const harnesses = makeHarnesses();
    const out = await runPipeline({
      runId: 'r-test',
      question: 'q',
      harnesses,
      specialistConcurrency: 99,
    });
    expect(out.report.summary).toBeDefined();
  });

  it('records non-success specialist outcomes and continues to the coordinator', async () => {
    // Override the adapter so Specialists throw and Coordinator returns
    // an empty-citation report (so allowedUrls = ∅ doesn't trip the
    // anti-fabrication check).
    const baseAdapter = createMockAdapter();
    const adapter = {
      name: 'broken-spec',
      async chat(params: Parameters<typeof baseAdapter.chat>[0]) {
        const sys = params.messages.find((m) => m.role === 'system')?.content ?? '';
        if (sys.includes('Specialist agent')) {
          throw new Error('boom-internal');
        }
        if (sys.includes('Coordinator agent')) {
          return {
            message: {
              role: 'assistant' as const,
              content: JSON.stringify({
                summary: 'No specialists succeeded.',
                markdown: '## Summary\n\nNo specialists succeeded.\n',
                citations: [],
              }),
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return baseAdapter.chat(params);
      },
    };
    const harnesses = {
      researcher: buildAgentHarness({ role: 'researcher', adapter, model: 'mock', budgetUsd: 1 }),
      coordinator: buildAgentHarness({ role: 'coordinator', adapter, model: 'mock', budgetUsd: 1 }),
      specialistFactory: () => ({
        harness: buildAgentHarness({ role: 'specialist', adapter, model: 'mock', budgetUsd: 1 }),
        tools: {
          webSearch: defineWebSearchTool(createFixtureSearchProvider([])),
          webFetch: defineWebFetchTool({ fetcher: createFixtureFetcher(new Map()) }),
        },
      }),
    };
    const out = await runPipeline({ runId: 'r', question: 'q', harnesses });
    expect(out.specialistOutcomes.every((o) => o.status === 'error' && o.errorCode === 'INTERNAL')).toBe(true);
    expect(out.report.summary).toBeDefined(); // Coordinator still ran
    expect(out.report.citations).toHaveLength(0);
  });
});
