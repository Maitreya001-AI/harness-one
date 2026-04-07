import { describe, it, expect } from 'vitest';
import {
  createRelevanceScorer,
  createFaithfulnessScorer,
  createLengthScorer,
  createCustomScorer,
} from '../scorers.js';

describe('createRelevanceScorer', () => {
  const scorer = createRelevanceScorer();

  it('scores high when output contains input keywords', async () => {
    const { score } = await scorer.score(
      'What is artificial intelligence?',
      'Artificial intelligence is a field of computer science.',
    );
    expect(score).toBeGreaterThan(0.5);
  });

  it('scores low when output is unrelated', async () => {
    const { score } = await scorer.score(
      'What is artificial intelligence?',
      'The weather today is sunny and warm.',
    );
    expect(score).toBeLessThan(0.5);
  });

  it('returns 1.0 for empty input', async () => {
    const { score } = await scorer.score('', 'some output');
    expect(score).toBe(1.0);
  });
});

describe('createFaithfulnessScorer', () => {
  const scorer = createFaithfulnessScorer();

  it('scores high when output is grounded in context', async () => {
    const { score } = await scorer.score(
      'question',
      'Paris is the capital of France',
      'France is a country in Europe. Paris is the capital of France.',
    );
    expect(score).toBeGreaterThan(0.5);
  });

  it('scores low when output is not grounded', async () => {
    const { score } = await scorer.score(
      'question',
      'Tokyo is the largest city in Japan with incredible technology',
      'France is a country in Europe. Paris is the capital.',
    );
    expect(score).toBeLessThan(0.5);
  });

  it('returns 1.0 when no context provided', async () => {
    const { score } = await scorer.score('question', 'answer');
    expect(score).toBe(1.0);
  });

  it('returns 0.0 for empty output', async () => {
    const { score } = await scorer.score('question', '', 'context');
    expect(score).toBe(0.0);
  });
});

describe('createLengthScorer', () => {
  it('scores 1.0 when within bounds', async () => {
    const scorer = createLengthScorer({ minTokens: 2, maxTokens: 100 });
    const { score } = await scorer.score('input', 'hello world this is a test sentence');
    expect(score).toBe(1.0);
  });

  it('scores low when below minimum', async () => {
    const scorer = createLengthScorer({ minTokens: 100 });
    const { score } = await scorer.score('input', 'short');
    expect(score).toBeLessThan(1.0);
  });

  it('scores low when above maximum', async () => {
    const scorer = createLengthScorer({ maxTokens: 1 });
    const { score } = await scorer.score('input', 'this has many words');
    expect(score).toBeLessThan(1.0);
  });
});

describe('createCustomScorer', () => {
  it('uses the provided scoring function', async () => {
    const scorer = createCustomScorer({
      name: 'polite',
      description: 'Checks politeness',
      scoreFn: async (_input, output) => ({
        score: output.includes('please') ? 1.0 : 0.0,
        explanation: 'Politeness check',
      }),
    });

    const { score: good } = await scorer.score('request', 'please help me');
    expect(good).toBe(1.0);

    const { score: bad } = await scorer.score('request', 'help me now');
    expect(bad).toBe(0.0);
  });

  it('has correct name and description', () => {
    const scorer = createCustomScorer({
      name: 'test-scorer',
      description: 'Test description',
      scoreFn: async () => ({ score: 0.5, explanation: 'test' }),
    });
    expect(scorer.name).toBe('test-scorer');
    expect(scorer.description).toBe('Test description');
  });
});
