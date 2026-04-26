import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runResearch } from '../../src/pipeline/run.js';
import { writeRunReport } from '../../src/observability/report-writer.js';
import { createMockAdapter, DEFAULT_SCRIPT } from '../../src/mock-adapter.js';
import { createFixtureSearchProvider } from '../../src/tools/web-search.js';
import { createFixtureFetcher, type FetchedPage } from '../../src/tools/web-fetch.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'rc-int-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ANTHROPIC_VERSION = '0.0.1';
const HARNESS_VERSION = '0.0.0';

const fixturePages = new Map<string, FetchedPage>([
  [
    'https://example.com/harness-one-orchestration',
    {
      url: 'https://example.com/harness-one-orchestration',
      title: 'Harness-one orchestration overview',
      content: 'Orchestration exposes registry, handoff, and shared context.',
      bytes: 64,
    },
  ],
  [
    'https://example.com/handoff-api',
    {
      url: 'https://example.com/handoff-api',
      title: 'createHandoff API',
      content: 'createHandoff layers structured handoff semantics on any MessageTransport.',
      bytes: 80,
    },
  ],
]);

describe('runResearch (integration)', () => {
  it('produces a successful report with non-empty pipeline + writes to disk', async () => {
    const adapter = createMockAdapter();
    const searchProvider = createFixtureSearchProvider([]);
    const fetcher = createFixtureFetcher(fixturePages);

    const outcome = await runResearch(
      { question: 'How does harness-one orchestration work?' },
      {
        adapter,
        searchProvider,
        fetcher,
        mocked: true,
        appVersion: ANTHROPIC_VERSION,
        harnessVersion: HARNESS_VERSION,
        specialistConcurrency: 2,
      },
    );

    expect(outcome.report.status).toBe('success');
    expect(outcome.pipeline?.subQuestions.length).toBe(DEFAULT_SCRIPT.subQuestions.length);
    expect(outcome.pipeline?.report.summary).toContain('orchestration');
    // Without explicit ModelPricing the harness CostTracker reports $0 even
    // though tokens were consumed — the schema is still populated.
    expect(outcome.report.cost.usd).toBeGreaterThanOrEqual(0);
    expect(outcome.report.cost.perAgent).toHaveLength(3);

    const path = await writeRunReport(tmp, outcome.report, {
      ...(outcome.pipeline?.report !== undefined && { research: outcome.pipeline.report }),
    });
    const fromDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(fromDisk.runId).toBe(outcome.report.runId);
  });

  it('classifies a researcher failure as error status', async () => {
    // Adapter returns malformed JSON for the researcher → ResearcherFailure.
    const broken = createMockAdapter({
      script: {
        subQuestions: DEFAULT_SCRIPT.subQuestions, // unused since prompt overrides
        specialistAnswers: DEFAULT_SCRIPT.specialistAnswers,
        report: DEFAULT_SCRIPT.report,
      },
    });
    // Wrap to inject malformed researcher response specifically.
    const adapter = {
      name: 'broken',
      async chat(params: Parameters<typeof broken.chat>[0]) {
        const sys = params.messages.find((m) => m.role === 'system')?.content ?? '';
        if (sys.includes('Researcher agent')) {
          return {
            message: { role: 'assistant' as const, content: 'not json' },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return broken.chat(params);
      },
    };
    const out = await runResearch(
      { question: 'q' },
      {
        adapter,
        searchProvider: createFixtureSearchProvider([]),
        fetcher: createFixtureFetcher(new Map()),
        appVersion: ANTHROPIC_VERSION,
        harnessVersion: HARNESS_VERSION,
        mocked: true,
      },
    );
    expect(out.report.status).toBe('error');
    expect(out.report.errorCode).toBe('ResearcherFailure');
  });

  it('records guardrail-block status when a Specialist surfaces an injection', async () => {
    const baseAdapter = createMockAdapter();
    // Specialists throw a guardrail-flavoured error; coordinator returns
    // an empty-citation report so the parser doesn't reject for missing
    // allowed URLs (no specialist answered → allowed set is ∅).
    const adapter = {
      name: 'inject',
      async chat(params: Parameters<typeof baseAdapter.chat>[0]) {
        const sys = params.messages.find((m) => m.role === 'system')?.content ?? '';
        if (sys.includes('Specialist agent')) {
          throw new Error('guardrail blocked: injected content');
        }
        if (sys.includes('Coordinator agent')) {
          return {
            message: {
              role: 'assistant' as const,
              content: JSON.stringify({
                summary: 'All specialists were blocked by guardrails.',
                markdown: '## Summary\n\nAll specialists were blocked by guardrails.\n',
                citations: [],
              }),
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return baseAdapter.chat(params);
      },
    };
    const out = await runResearch(
      { question: 'q' },
      {
        adapter,
        searchProvider: createFixtureSearchProvider([]),
        fetcher: createFixtureFetcher(new Map()),
        appVersion: ANTHROPIC_VERSION,
        harnessVersion: HARNESS_VERSION,
        mocked: true,
      },
    );
    // Specialists fail individually; pipeline still calls Coordinator.
    // Coordinator gets empty answers → a successful report with empty citations.
    expect(out.pipeline?.specialistOutcomes.every((o) => o.status === 'guardrail_blocked')).toBe(true);
    expect(out.report.status).toBe('success');
  });
});
