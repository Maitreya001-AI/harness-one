import { describe, expect, it } from 'vitest';

import { EnvError, readEnv } from '../../src/cli/env.js';
import { DEFAULT_BUDGET_USD, DEFAULT_MODEL } from '../../src/config/defaults.js';

describe('readEnv', () => {
  it('defaults to mocked when no anthropic key', () => {
    const cfg = readEnv({});
    expect(cfg.mocked).toBe(true);
    expect(cfg.budgetUsd).toBe(DEFAULT_BUDGET_USD);
    expect(cfg.model).toBe(DEFAULT_MODEL);
    expect(cfg.searchProvider).toBe('fixture');
  });

  it('promotes to live mode when anthropic key present', () => {
    const cfg = readEnv({ ANTHROPIC_API_KEY: 'k' });
    expect(cfg.mocked).toBe(false);
    expect(cfg.searchProvider).toBe('fixture');
  });

  it('honours explicit RESEARCH_MOCK=1 override', () => {
    const cfg = readEnv({ ANTHROPIC_API_KEY: 'k', RESEARCH_MOCK: '1' });
    expect(cfg.mocked).toBe(true);
  });

  it('reads model + budget overrides', () => {
    const cfg = readEnv({
      ANTHROPIC_API_KEY: 'k',
      RESEARCH_MODEL: 'claude-haiku-4-5',
      RESEARCH_BUDGET_USD: '7.5',
    });
    expect(cfg.model).toBe('claude-haiku-4-5');
    expect(cfg.budgetUsd).toBe(7.5);
  });

  it('throws on bad budget', () => {
    expect(() => readEnv({ RESEARCH_BUDGET_USD: 'oops' })).toThrow(EnvError);
    expect(() => readEnv({ RESEARCH_BUDGET_USD: '0' })).toThrow(/positive number/);
    expect(() => readEnv({ RESEARCH_BUDGET_USD: '-1' })).toThrow(/positive number/);
  });

  it('infers serpapi when key is set in live mode', () => {
    const cfg = readEnv({ ANTHROPIC_API_KEY: 'a', SERPAPI_API_KEY: 's' });
    expect(cfg.searchProvider).toBe('serpapi');
  });

  it('infers brave when key is set in live mode', () => {
    const cfg = readEnv({ ANTHROPIC_API_KEY: 'a', BRAVE_SEARCH_API_KEY: 'b' });
    expect(cfg.searchProvider).toBe('brave');
  });

  it('honours RESEARCH_SEARCH_PROVIDER explicit selection', () => {
    const cfg = readEnv({ RESEARCH_SEARCH_PROVIDER: 'fixture' });
    expect(cfg.searchProvider).toBe('fixture');
  });

  it('rejects unknown RESEARCH_SEARCH_PROVIDER values', () => {
    expect(() => readEnv({ RESEARCH_SEARCH_PROVIDER: 'duckduckgo' })).toThrow(EnvError);
  });

  it('rejects serpapi selection without key', () => {
    expect(() => readEnv({ ANTHROPIC_API_KEY: 'a', RESEARCH_SEARCH_PROVIDER: 'serpapi' })).toThrow(
      /SERPAPI_API_KEY/,
    );
  });

  it('rejects brave selection without key', () => {
    expect(() => readEnv({ ANTHROPIC_API_KEY: 'a', RESEARCH_SEARCH_PROVIDER: 'brave' })).toThrow(
      /BRAVE_SEARCH_API_KEY/,
    );
  });

  it('uses default reports root from cwd when not specified', () => {
    const cfg = readEnv({});
    expect(cfg.reportsRoot).toContain('research-reports');
  });

  it('honours RESEARCH_REPORTS_ROOT override', () => {
    const cfg = readEnv({ RESEARCH_REPORTS_ROOT: '/tmp/x' });
    expect(cfg.reportsRoot).toBe('/tmp/x');
  });
});
