import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main.js';
import { createMockAdapter, DEFAULT_SCRIPT } from '../../src/mock-adapter.js';
import { createFixtureSearchProvider } from '../../src/tools/web-search.js';
import { createFixtureFetcher, type FetchedPage } from '../../src/tools/web-fetch.js';

let tmp: string;
const stdout: string[] = [];
const stderr: string[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'rc-cli-'));
  stdout.length = 0;
  stderr.length = 0;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function fixturePagesFromScript(): ReadonlyMap<string, FetchedPage> {
  const m = new Map<string, FetchedPage>();
  for (const ans of DEFAULT_SCRIPT.specialistAnswers) {
    for (const c of ans.citations) {
      m.set(c.url, {
        url: c.url,
        title: c.title,
        content: c.excerpt,
        bytes: new TextEncoder().encode(c.excerpt).byteLength,
      });
    }
  }
  return m;
}

const runtimeOptions = {
  adapterFactory: async () => createMockAdapter(),
  searchProviderFactory: () => createFixtureSearchProvider([]),
  fetcherFactory: () => createFixtureFetcher(fixturePagesFromScript()),
} as const;

describe('runCli', () => {
  it('runs the pipeline end-to-end in mock mode and writes the report', async () => {
    const result = await runCli({
      argv: ['What is X?', '--reports-root', tmp, '--print'],
      env: { RESEARCH_MOCK: '1' },
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
      runtimeOptions,
    });
    expect(result.exitCode).toBe(0);
    expect(result.report?.status).toBe('success');
    const day = result.report!.timestamp.slice(0, 10);
    const files = await readdir(join(tmp, 'runs', day));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const json = JSON.parse(await readFile(join(tmp, 'runs', day, files.find((f) => f.endsWith('.json'))!), 'utf8'));
    expect(json.runId).toBe(result.report!.runId);
    expect(stdout.join('')).toContain('## Sources');
  });

  it('returns exit code 2 on bad args', async () => {
    const r = await runCli({
      argv: [],
      env: { RESEARCH_MOCK: '1' },
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
      runtimeOptions,
    });
    expect(r.exitCode).toBe(2);
  });

  it('returns exit code 0 on --help', async () => {
    const r = await runCli({
      argv: ['--help'],
      env: { RESEARCH_MOCK: '1' },
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
      runtimeOptions,
    });
    expect(r.exitCode).toBe(0);
  });

  it('returns exit code 2 on env error', async () => {
    const r = await runCli({
      argv: ['q'],
      env: { RESEARCH_BUDGET_USD: 'broken' },
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
      runtimeOptions,
    });
    expect(r.exitCode).toBe(2);
    expect(stderr.join('')).toContain('RESEARCH_BUDGET_USD');
  });

  it('skips persistence when --no-report supplied', async () => {
    await runCli({
      argv: ['q', '--no-report'],
      env: { RESEARCH_MOCK: '1' },
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
      runtimeOptions,
    });
    const files = await readdir(tmp).catch(() => []);
    expect(files.length).toBe(0);
  });

  it('writes JSON only when --no-markdown supplied', async () => {
    const r = await runCli({
      argv: ['q', '--no-markdown', '--reports-root', tmp],
      env: { RESEARCH_MOCK: '1' },
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
      runtimeOptions,
    });
    expect(r.exitCode).toBe(0);
    const day = r.report!.timestamp.slice(0, 10);
    const files = await readdir(join(tmp, 'runs', day));
    expect(files.some((f) => f.endsWith('.md'))).toBe(false);
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
  });
});
