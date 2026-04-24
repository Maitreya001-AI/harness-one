import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { main } from '../src/entry.js';
import type { RunReport } from '../src/types.js';

async function writeEvent(body: unknown): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dogfood-entry-'));
  const path = join(dir, 'event.json');
  await writeFile(path, JSON.stringify(body), 'utf8');
  return { dir, path };
}

async function readReport(reportsRoot: string, day: string, issue: number): Promise<RunReport> {
  const path = join(reportsRoot, 'runs', day, `${issue}.json`);
  return JSON.parse(await readFile(path, 'utf8')) as RunReport;
}

describe('entry.main (mock adapter, dry run)', () => {
  it('writes a success report without posting a comment', async () => {
    const { path } = await writeEvent({
      action: 'opened',
      issue: {
        number: 999,
        title: 'Test issue',
        body: 'Body for integration test.',
        html_url: 'https://github.com/a/b/issues/999',
        user: { login: 'alice', type: 'User' },
      },
    });
    const reportsRoot = await mkdtemp(join(tmpdir(), 'dogfood-out-'));
    const env: NodeJS.ProcessEnv = {
      GITHUB_EVENT_PATH: path,
      GITHUB_REPOSITORY: 'a/b',
      DOGFOOD_REPORTS_ROOT: reportsRoot,
      DOGFOOD_DRY_RUN: '1',
      DOGFOOD_MOCK: '1',
    };
    const report = await main(env);
    expect(report.status).toBe('success');
    expect(report.mocked).toBe(true);
    const persisted = await readReport(
      reportsRoot,
      report.timestamp.slice(0, 10),
      999,
    );
    expect(persisted.verdict?.suggestedLabels).toContain('bug');
  });

  it('fast-paths bot authors without invoking the harness', async () => {
    const { path } = await writeEvent({
      action: 'opened',
      issue: {
        number: 888,
        title: 'from bot',
        body: '',
        html_url: 'https://github.com/a/b/issues/888',
        user: { login: 'dependabot[bot]', type: 'Bot' },
      },
    });
    const reportsRoot = await mkdtemp(join(tmpdir(), 'dogfood-out-'));
    const env: NodeJS.ProcessEnv = {
      GITHUB_EVENT_PATH: path,
      GITHUB_REPOSITORY: 'a/b',
      DOGFOOD_REPORTS_ROOT: reportsRoot,
      DOGFOOD_DRY_RUN: '1',
      DOGFOOD_MOCK: '1',
    };
    const report = await main(env);
    expect(report.status).toBe('success');
    expect(report.verdict).toBeUndefined();
    expect(report.cost.usd).toBe(0);
  });
});
