import { describe, expect, it } from 'vitest';

import { parseVerdict, VerdictParseError } from '../../src/triage/parse-verdict.js';

const VALID = {
  suggestedLabels: ['bug', 'adapter'],
  duplicates: [
    {
      issueNumber: 42,
      title: 'Earlier adapter bug',
      url: 'https://github.com/foo/bar/issues/42',
      confidence: 'high',
    },
  ],
  reproSteps: ['Run pnpm test.'],
  rationale: 'Matches a closed issue on the Anthropic adapter.',
};

describe('parseVerdict', () => {
  it('parses a valid JSON object', () => {
    const v = parseVerdict(JSON.stringify(VALID));
    expect(v.suggestedLabels).toEqual(['bug', 'adapter']);
    expect(v.duplicates).toHaveLength(1);
    expect(v.rationale).toMatch(/Anthropic/);
  });

  it('tolerates ```json fenced output', () => {
    const wrapped = '```json\n' + JSON.stringify(VALID) + '\n```';
    const v = parseVerdict(wrapped);
    expect(v.suggestedLabels).toEqual(['bug', 'adapter']);
  });

  it('drops unknown labels rather than throwing', () => {
    const payload = { ...VALID, suggestedLabels: ['bug', 'make-coffee', 'adapter'] };
    const v = parseVerdict(JSON.stringify(payload));
    expect(v.suggestedLabels).toEqual(['bug', 'adapter']);
  });

  it('dedupes labels', () => {
    const payload = { ...VALID, suggestedLabels: ['bug', 'bug', 'adapter'] };
    const v = parseVerdict(JSON.stringify(payload));
    expect(v.suggestedLabels).toEqual(['bug', 'adapter']);
  });

  it('rejects non-JSON', () => {
    expect(() => parseVerdict('hello there')).toThrow(VerdictParseError);
  });

  it('rejects arrays at top level', () => {
    expect(() => parseVerdict('[]')).toThrow(/JSON object/);
  });

  it('rejects duplicates with non-integer issueNumber', () => {
    const payload = {
      ...VALID,
      duplicates: [{ ...VALID.duplicates[0], issueNumber: 12.5 }],
    };
    expect(() => parseVerdict(JSON.stringify(payload))).toThrow(/issueNumber/);
  });

  it('rejects duplicates with non-github URL', () => {
    const payload = {
      ...VALID,
      duplicates: [{ ...VALID.duplicates[0], url: 'https://evil.example.com/1' }],
    };
    expect(() => parseVerdict(JSON.stringify(payload))).toThrow('github.com');
  });

  it('rejects duplicates with unknown confidence', () => {
    const payload = {
      ...VALID,
      duplicates: [{ ...VALID.duplicates[0], confidence: 'certain' }],
    };
    expect(() => parseVerdict(JSON.stringify(payload))).toThrow(/confidence/);
  });

  it('clamps reproSteps to 5 and rationale to 200 chars', () => {
    const payload = {
      ...VALID,
      reproSteps: Array.from({ length: 10 }, (_, i) => `step ${i}`),
      rationale: 'a'.repeat(500),
    };
    const v = parseVerdict(JSON.stringify(payload));
    expect(v.reproSteps).toHaveLength(5);
    expect(v.rationale).toHaveLength(200);
  });

  it('requires rationale to be a string', () => {
    const payload = { ...VALID, rationale: 42 };
    expect(() => parseVerdict(JSON.stringify(payload))).toThrow(/rationale/);
  });
});
