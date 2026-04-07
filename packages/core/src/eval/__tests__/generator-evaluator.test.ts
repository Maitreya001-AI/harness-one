import { describe, it, expect } from 'vitest';
import { runGeneratorEvaluator } from '../generator-evaluator.js';
import { HarnessError } from '../../core/errors.js';

describe('runGeneratorEvaluator', () => {
  it('returns on first pass', async () => {
    const result = await runGeneratorEvaluator(
      {
        generate: async (input) => `answer: ${input}`,
        evaluate: async () => ({ pass: true, feedback: '' }),
      },
      'question',
    );
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.output).toBe('answer: question');
  });

  it('retries until passing', async () => {
    let attempt = 0;
    const result = await runGeneratorEvaluator(
      {
        generate: async (input) => {
          attempt++;
          return `attempt-${attempt}: ${input}`;
        },
        evaluate: async (_input, output) => {
          if (output.startsWith('attempt-3')) {
            return { pass: true, feedback: '' };
          }
          return { pass: false, feedback: 'Try harder' };
        },
        maxRetries: 5,
      },
      'q',
    );
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('returns failed after max retries', async () => {
    const result = await runGeneratorEvaluator(
      {
        generate: async (input) => input,
        evaluate: async () => ({ pass: false, feedback: 'Never good enough' }),
        maxRetries: 2,
      },
      'q',
    );
    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.feedback).toBe('Never good enough');
  });

  it('passes feedback to subsequent generate calls', async () => {
    const inputs: string[] = [];
    await runGeneratorEvaluator(
      {
        generate: async (input) => {
          inputs.push(input);
          return 'output';
        },
        evaluate: async () => ({ pass: false, feedback: 'be better' }),
        maxRetries: 2,
      },
      'original',
    );
    expect(inputs[0]).toBe('original');
    expect(inputs[1]).toContain('be better');
  });

  it('throws on maxRetries < 1', async () => {
    await expect(
      runGeneratorEvaluator(
        {
          generate: async (i) => i,
          evaluate: async () => ({ pass: true, feedback: '' }),
          maxRetries: 0,
        },
        'q',
      ),
    ).rejects.toThrow(HarnessError);
  });
});
