/**
 * Read CLI-relevant environment variables into a typed config bag.
 *
 * Validation is intentionally up-front and explicit — bad env values throw
 * before any agent spins up so the user sees the error immediately, not
 * after a 30-second budget exhaustion.
 */

import { resolve } from 'node:path';

import { DEFAULT_BUDGET_USD, DEFAULT_MODEL } from '../config/defaults.js';

export type SearchProviderName = 'serpapi' | 'brave' | 'fixture';

export interface EnvConfig {
  readonly mocked: boolean;
  readonly model: string;
  readonly budgetUsd: number;
  readonly reportsRoot: string;
  readonly searchProvider: SearchProviderName;
  readonly anthropicApiKey?: string;
  readonly serpapiApiKey?: string;
  readonly braveApiKey?: string;
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const mocked = env['RESEARCH_MOCK'] === '1' || env['ANTHROPIC_API_KEY'] === undefined;
  const model = env['RESEARCH_MODEL'] ?? DEFAULT_MODEL;
  const budgetUsd = parseBudget(env['RESEARCH_BUDGET_USD']);
  const reportsRoot = env['RESEARCH_REPORTS_ROOT'] ?? resolve(process.cwd(), 'research-reports');
  const searchProvider = pickSearchProvider(env, mocked);

  const config: EnvConfig = {
    mocked,
    model,
    budgetUsd,
    reportsRoot,
    searchProvider,
    ...(env['ANTHROPIC_API_KEY'] !== undefined && { anthropicApiKey: env['ANTHROPIC_API_KEY'] }),
    ...(env['SERPAPI_API_KEY'] !== undefined && { serpapiApiKey: env['SERPAPI_API_KEY'] }),
    ...(env['BRAVE_SEARCH_API_KEY'] !== undefined && { braveApiKey: env['BRAVE_SEARCH_API_KEY'] }),
  };

  validateProviderCredentials(config);
  return config;
}

function parseBudget(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_BUDGET_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new EnvError(`RESEARCH_BUDGET_USD must be a positive number; got ${JSON.stringify(raw)}`);
  }
  return n;
}

function pickSearchProvider(env: NodeJS.ProcessEnv, mocked: boolean): SearchProviderName {
  const explicit = env['RESEARCH_SEARCH_PROVIDER'];
  if (explicit === 'serpapi' || explicit === 'brave' || explicit === 'fixture') return explicit;
  if (explicit !== undefined) {
    throw new EnvError(`RESEARCH_SEARCH_PROVIDER must be one of: serpapi, brave, fixture (got ${JSON.stringify(explicit)})`);
  }
  if (mocked) return 'fixture';
  if (env['SERPAPI_API_KEY']) return 'serpapi';
  if (env['BRAVE_SEARCH_API_KEY']) return 'brave';
  return 'fixture';
}

function validateProviderCredentials(cfg: EnvConfig): void {
  if (cfg.searchProvider === 'serpapi' && !cfg.serpapiApiKey) {
    throw new EnvError('RESEARCH_SEARCH_PROVIDER=serpapi requires SERPAPI_API_KEY');
  }
  if (cfg.searchProvider === 'brave' && !cfg.braveApiKey) {
    throw new EnvError('RESEARCH_SEARCH_PROVIDER=brave requires BRAVE_SEARCH_API_KEY');
  }
}
