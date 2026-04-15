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

describe('createRelevanceScorer edge cases', () => {
  const scorer = createRelevanceScorer();

  it('returns 1.0 when input and output are identical', async () => {
    const text = 'artificial intelligence machine learning';
    const { score } = await scorer.score(text, text);
    expect(score).toBe(1.0);
  });

  it('returns ~0.0 when input and output are completely unrelated', async () => {
    const { score } = await scorer.score(
      'quantum entanglement photon',
      'basketball football soccer',
    );
    expect(score).toBe(0.0);
  });
});

describe('createLengthScorer boundary cases', () => {
  it('scores 1.0 at exactly minTokens boundary', async () => {
    // "hello world" tokenizes to ["hello", "world"] after stopword removal (2 tokens)
    const scorer = createLengthScorer({ minTokens: 2, maxTokens: 100 });
    const { score } = await scorer.score('input', 'hello world');
    expect(score).toBe(1.0);
  });

  it('scores 1.0 at exactly maxTokens boundary', async () => {
    // "hello world" tokenizes to ["hello", "world"] — 2 tokens
    const scorer = createLengthScorer({ minTokens: 0, maxTokens: 2 });
    const { score } = await scorer.score('input', 'hello world');
    expect(score).toBe(1.0);
  });

  it('scores < 1.0 when one token below minTokens', async () => {
    // "hello" tokenizes to ["hello"] — 1 token, minTokens = 2
    const scorer = createLengthScorer({ minTokens: 2, maxTokens: 100 });
    const { score } = await scorer.score('input', 'hello');
    expect(score).toBeLessThan(1.0);
    expect(score).toBe(0.5); // 1/2 = 0.5
  });

  it('scores < 1.0 when one token above maxTokens', async () => {
    // "hello world test" tokenizes to ["hello", "world", "test"] — 3 tokens, maxTokens = 2
    const scorer = createLengthScorer({ minTokens: 0, maxTokens: 2 });
    const { score } = await scorer.score('input', 'hello world test');
    expect(score).toBeLessThan(1.0);
    expect(score).toBeCloseTo(2 / 3, 4); // maxTokens/tokens = 2/3
  });
});

describe('createCustomScorer async error handling', () => {
  it('propagates async errors from the scoring function', async () => {
    const scorer = createCustomScorer({
      name: 'erroring',
      description: 'Throws async error',
      scoreFn: async () => {
        throw new Error('Async scorer failure');
      },
    });

    await expect(scorer.score('input', 'output')).rejects.toThrow('Async scorer failure');
  });

  it('handles rejected promise from scoring function', async () => {
    const scorer = createCustomScorer({
      name: 'rejecting',
      description: 'Returns rejected promise',
      scoreFn: () => Promise.reject(new Error('Rejected scorer')),
    });

    await expect(scorer.score('input', 'output')).rejects.toThrow('Rejected scorer');
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
