import { describe, it, expect } from 'vitest';
import { createConfigFromEnv } from '../env.js';

describe('createConfigFromEnv', () => {
  it('returns empty object when no relevant env vars are set', () => {
    const config = createConfigFromEnv({});
    expect(config).toEqual({});
  });

  it('reads HARNESS_PROVIDER', () => {
    const config = createConfigFromEnv({ HARNESS_PROVIDER: 'anthropic' });
    expect(config.provider).toBe('anthropic');
  });

  it('reads HARNESS_MODEL', () => {
    const config = createConfigFromEnv({ HARNESS_MODEL: 'claude-sonnet-4-20250514' });
    expect(config.model).toBe('claude-sonnet-4-20250514');
  });

  it('reads HARNESS_MAX_ITERATIONS as integer', () => {
    const config = createConfigFromEnv({ HARNESS_MAX_ITERATIONS: '10' });
    expect(config.maxIterations).toBe(10);
  });

  it('reads HARNESS_MAX_TOKENS as integer', () => {
    const config = createConfigFromEnv({ HARNESS_MAX_TOKENS: '50000' });
    expect(config.maxTotalTokens).toBe(50000);
  });

  it('reads HARNESS_BUDGET as float', () => {
    const config = createConfigFromEnv({ HARNESS_BUDGET: '10.50' });
    expect(config.budget).toBe(10.5);
  });

  it('reads all env vars together', () => {
    const config = createConfigFromEnv({
      HARNESS_PROVIDER: 'openai',
      HARNESS_MODEL: 'gpt-4',
      HARNESS_MAX_ITERATIONS: '5',
      HARNESS_MAX_TOKENS: '100000',
      HARNESS_BUDGET: '25.00',
    });

    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-4');
    expect(config.maxIterations).toBe(5);
    expect(config.maxTotalTokens).toBe(100000);
    expect(config.budget).toBe(25);
  });

  it('ignores NaN for HARNESS_MAX_ITERATIONS', () => {
    const config = createConfigFromEnv({ HARNESS_MAX_ITERATIONS: 'not-a-number' });
    expect(config.maxIterations).toBeUndefined();
  });

  it('ignores NaN for HARNESS_MAX_TOKENS', () => {
    const config = createConfigFromEnv({ HARNESS_MAX_TOKENS: 'abc' });
    expect(config.maxTotalTokens).toBeUndefined();
  });

  it('ignores NaN for HARNESS_BUDGET', () => {
    const config = createConfigFromEnv({ HARNESS_BUDGET: 'xyz' });
    expect(config.budget).toBeUndefined();
  });

  it('ignores undefined env values', () => {
    const config = createConfigFromEnv({
      HARNESS_PROVIDER: undefined,
      HARNESS_MODEL: undefined,
    });
    expect(config).toEqual({});
  });

  it('does not include unrelated env vars', () => {
    const config = createConfigFromEnv({
      HOME: '/home/user',
      PATH: '/usr/bin',
      NODE_ENV: 'production',
    });
    expect(config).toEqual({});
  });

  it('handles empty string values', () => {
    // Empty strings are falsy for parseInt/parseFloat but truthy for string checks
    const config = createConfigFromEnv({
      HARNESS_MAX_ITERATIONS: '',
      HARNESS_MAX_TOKENS: '',
      HARNESS_BUDGET: '',
    });
    // Empty string parseInt/parseFloat -> NaN, should be excluded
    expect(config.maxIterations).toBeUndefined();
    expect(config.maxTotalTokens).toBeUndefined();
    expect(config.budget).toBeUndefined();
  });

  it('defaults to process.env when no env argument is provided', () => {
    // We just verify it does not throw; actual process.env content varies
    const config = createConfigFromEnv();
    expect(config).toBeDefined();
    expect(typeof config).toBe('object');
  });

  it('ignores invalid HARNESS_PROVIDER values', () => {
    const config = createConfigFromEnv({ HARNESS_PROVIDER: 'invalid-provider' });
    expect(config.provider).toBeUndefined();
  });

  it('ignores empty string for HARNESS_PROVIDER', () => {
    const config = createConfigFromEnv({ HARNESS_PROVIDER: '' });
    expect(config.provider).toBeUndefined();
  });

  it('accepts "anthropic" as valid HARNESS_PROVIDER', () => {
    const config = createConfigFromEnv({ HARNESS_PROVIDER: 'anthropic' });
    expect(config.provider).toBe('anthropic');
  });

  it('accepts "openai" as valid HARNESS_PROVIDER', () => {
    const config = createConfigFromEnv({ HARNESS_PROVIDER: 'openai' });
    expect(config.provider).toBe('openai');
  });
});
