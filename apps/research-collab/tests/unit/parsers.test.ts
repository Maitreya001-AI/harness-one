import { describe, expect, it } from 'vitest';

import {
  ParseError,
  parseResearchReport,
  parseSpecialistAnswer,
  parseSubQuestions,
} from '../../src/pipeline/parsers.js';

describe('parseSubQuestions', () => {
  const valid = JSON.stringify({
    subQuestions: [
      { index: 1, text: 'What is X?', rationale: 'X is the foundation.' },
      { index: 2, text: 'How does Y compare?', rationale: 'Y is the alternative.' },
    ],
  });

  it('parses valid JSON', () => {
    const out = parseSubQuestions(valid);
    expect(out).toHaveLength(2);
    expect(out[0]?.index).toBe(1);
    expect(out[1]?.text).toBe('How does Y compare?');
  });

  it('tolerates ```json fences', () => {
    const fenced = '```json\n' + valid + '\n```';
    const out = parseSubQuestions(fenced);
    expect(out).toHaveLength(2);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseSubQuestions('not json')).toThrow(ParseError);
  });

  it('rejects non-object root', () => {
    expect(() => parseSubQuestions('[1,2]')).toThrow(/JSON object/);
  });

  it('rejects missing subQuestions field', () => {
    expect(() => parseSubQuestions('{}')).toThrow(/subQuestions/);
  });

  it('rejects out-of-bounds length', () => {
    const empty = JSON.stringify({ subQuestions: [] });
    expect(() => parseSubQuestions(empty)).toThrow(/length/);
  });

  it('rejects non-object entries', () => {
    const bad = JSON.stringify({ subQuestions: ['a'] });
    expect(() => parseSubQuestions(bad)).toThrow(/must be an object/);
  });

  it('rejects mismatched index', () => {
    const bad = JSON.stringify({ subQuestions: [{ index: 5, text: 'q?', rationale: 'r' }] });
    expect(() => parseSubQuestions(bad)).toThrow(/index must equal 1/);
  });

  it('rejects empty text', () => {
    const bad = JSON.stringify({ subQuestions: [{ index: 1, text: '', rationale: 'r' }] });
    expect(() => parseSubQuestions(bad)).toThrow(/text must be non-empty/);
  });

  it('rejects empty rationale', () => {
    const bad = JSON.stringify({ subQuestions: [{ index: 1, text: 'q', rationale: '' }] });
    expect(() => parseSubQuestions(bad)).toThrow(/rationale must be non-empty/);
  });

  it('rejects non-string text', () => {
    const bad = JSON.stringify({ subQuestions: [{ index: 1, text: 1, rationale: 'r' }] });
    expect(() => parseSubQuestions(bad)).toThrow(/must be a string/);
  });
});

describe('parseSpecialistAnswer', () => {
  const fetched = new Set(['https://a.example/page']);
  const valid = JSON.stringify({
    answer: 'X is foundational.',
    confidence: 'high',
    citations: [
      { url: 'https://a.example/page', title: 'A', excerpt: 'X is foundational.' },
    ],
  });

  it('parses valid JSON', () => {
    const out = parseSpecialistAnswer(valid, { subQuestionIndex: 7, fetchedUrls: fetched });
    expect(out.subQuestionIndex).toBe(7);
    expect(out.confidence).toBe('high');
    expect(out.citations).toHaveLength(1);
  });

  it('rejects unknown URL when fetchedUrls is supplied', () => {
    const bad = JSON.stringify({
      answer: 'X.',
      confidence: 'low',
      citations: [{ url: 'https://other.example/x', title: 'O', excerpt: 'X.' }],
    });
    expect(() => parseSpecialistAnswer(bad, { subQuestionIndex: 1, fetchedUrls: fetched })).toThrow(
      /not fetched/,
    );
  });

  it('skips fetched-URL check when fetchedUrls omitted', () => {
    const out = parseSpecialistAnswer(
      JSON.stringify({
        answer: 'a',
        confidence: 'low',
        citations: [{ url: 'https://other.example/x', title: 'O', excerpt: 'a' }],
      }),
      { subQuestionIndex: 1 },
    );
    expect(out.citations[0]?.url).toBe('https://other.example/x');
  });

  it('rejects citations array missing', () => {
    const bad = JSON.stringify({ answer: 'a', confidence: 'low' });
    expect(() => parseSpecialistAnswer(bad, { subQuestionIndex: 1 })).toThrow(/citations/);
  });

  it('rejects citations entry not an object', () => {
    const bad = JSON.stringify({ answer: 'a', confidence: 'low', citations: ['x'] });
    expect(() => parseSpecialistAnswer(bad, { subQuestionIndex: 1 })).toThrow(/citations\[0\]/);
  });

  it('rejects non-https URL', () => {
    const bad = JSON.stringify({
      answer: 'a',
      confidence: 'low',
      citations: [{ url: 'http://x', title: 't', excerpt: 'e' }],
    });
    expect(() => parseSpecialistAnswer(bad, { subQuestionIndex: 1 })).toThrow(/https:\/\/ URL/);
  });

  it('rejects bad confidence', () => {
    const bad = JSON.stringify({ answer: 'a', confidence: 'unsure', citations: [] });
    expect(() => parseSpecialistAnswer(bad, { subQuestionIndex: 1 })).toThrow(/confidence/);
  });

  it('rejects empty answer', () => {
    const bad = JSON.stringify({ answer: '   ', confidence: 'low', citations: [] });
    expect(() => parseSpecialistAnswer(bad, { subQuestionIndex: 1 })).toThrow(/answer must be non-empty/);
  });

  it('dedupes citations by URL', () => {
    const dup = JSON.stringify({
      answer: 'a',
      confidence: 'low',
      citations: [
        { url: 'https://a.example/x', title: 't', excerpt: 'e' },
        { url: 'https://a.example/x', title: 't2', excerpt: 'e2' },
      ],
    });
    const out = parseSpecialistAnswer(dup, { subQuestionIndex: 1 });
    expect(out.citations).toHaveLength(1);
  });
});

describe('parseResearchReport', () => {
  const allowedUrls = new Set(['https://a.example/x']);
  const valid = JSON.stringify({
    summary: 'Summary line.',
    markdown: '## Section\n\nbody',
    citations: [{ url: 'https://a.example/x', title: 't', excerpt: 'e' }],
  });

  it('parses valid JSON', () => {
    const out = parseResearchReport(valid, { allowedUrls });
    expect(out.summary).toBe('Summary line.');
    expect(out.citations).toHaveLength(1);
  });

  it('rejects empty markdown', () => {
    const bad = JSON.stringify({ summary: 's', markdown: '   ', citations: [] });
    expect(() => parseResearchReport(bad, { allowedUrls })).toThrow(/markdown/);
  });

  it('rejects empty summary', () => {
    const bad = JSON.stringify({ summary: ' ', markdown: 'md', citations: [] });
    expect(() => parseResearchReport(bad, { allowedUrls })).toThrow(/summary must be non-empty/);
  });

  it('rejects too-long summary', () => {
    const bad = JSON.stringify({ summary: 'x'.repeat(900), markdown: 'md', citations: [] });
    expect(() => parseResearchReport(bad, { allowedUrls })).toThrow(/<= 800/);
  });

  it('rejects fabricated citation URL', () => {
    const bad = JSON.stringify({
      summary: 's',
      markdown: 'md',
      citations: [{ url: 'https://other.example/x', title: 't', excerpt: 'e' }],
    });
    expect(() => parseResearchReport(bad, { allowedUrls })).toThrow(/not cited/);
  });

  it('rejects citations not an array', () => {
    const bad = JSON.stringify({ summary: 's', markdown: 'md', citations: 'foo' });
    expect(() => parseResearchReport(bad, { allowedUrls })).toThrow(/citations/);
  });

  it('rejects non-https citation URL', () => {
    const bad = JSON.stringify({
      summary: 's',
      markdown: 'md',
      citations: [{ url: 'ftp://a', title: 't', excerpt: 'e' }],
    });
    expect(() => parseResearchReport(bad, { allowedUrls })).toThrow(/https:\/\//);
  });

  it('rejects citation entry not an object', () => {
    const bad = JSON.stringify({ summary: 's', markdown: 'md', citations: [42] });
    expect(() => parseResearchReport(bad, { allowedUrls })).toThrow(/citations\[0\]/);
  });

  it('strips bare ```fence``` (no language tag)', () => {
    const fenced = '```\n' + valid + '\n```';
    const out = parseResearchReport(fenced, { allowedUrls });
    expect(out.summary).toBe('Summary line.');
  });
});
