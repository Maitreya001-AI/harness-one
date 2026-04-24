import { describe, expect, it } from 'vitest';

import { renderTriageComment } from '../../src/triage/render-comment.js';
import type { TriageVerdict } from '../../src/types.js';

const BASE_VERDICT: TriageVerdict = {
  suggestedLabels: ['bug', 'adapter'],
  duplicates: [
    {
      issueNumber: 77,
      title: 'Older adapter regression',
      url: 'https://github.com/Maitreya001-AI/harness-one/issues/77',
      confidence: 'medium',
    },
  ],
  reproSteps: ['Clone main and run pnpm test.'],
  rationale: 'Mirrors issue #77 closed last week.',
};

describe('renderTriageComment', () => {
  it('includes the disclaimer, labels, duplicate link, and trace footer', () => {
    const body = renderTriageComment(BASE_VERDICT, {
      harnessVersion: '0.1.0',
      traceId: 'trace-abc',
      costUsd: 0.0123,
      mocked: false,
    });
    expect(body).toContain('Automated triage by the harness-one dogfood bot');
    expect(body).toContain('`bug`');
    expect(body).toContain('`adapter`');
    expect(body).toContain('#77 Older adapter regression');
    expect(body).toContain('trace `trace-abc`');
    expect(body).toContain('$0.0123');
    expect(body).not.toContain('mock run');
  });

  it('marks mock runs so a reviewer can tell at a glance', () => {
    const body = renderTriageComment(BASE_VERDICT, {
      harnessVersion: '0.1.0',
      traceId: undefined,
      costUsd: 0,
      mocked: true,
    });
    expect(body).toContain('mock run');
    expect(body).not.toContain('trace `');
  });

  it('handles empty label / duplicate / repro arrays', () => {
    const body = renderTriageComment(
      {
        suggestedLabels: [],
        duplicates: [],
        reproSteps: [],
        rationale: 'Body too short to triage.',
      },
      { harnessVersion: '0.1.0', traceId: undefined, costUsd: 0, mocked: false },
    );
    expect(body).toContain('No label suggestion');
    expect(body).toContain('No likely duplicate');
    expect(body).toContain('could not propose repro');
  });
});
