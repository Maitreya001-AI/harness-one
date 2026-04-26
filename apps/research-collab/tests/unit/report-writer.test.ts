import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeRunReport } from '../../src/observability/report-writer.js';
import type { RunReport } from '../../src/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'research-collab-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const sample = (overrides: Partial<RunReport> = {}): RunReport => ({
  schemaVersion: 1,
  harnessVersion: '0.0.0',
  appVersion: '0.0.1',
  timestamp: '2026-04-26T10:00:00.000Z',
  runId: 'run-1',
  source: 'cli',
  questionFingerprint: 'abc123',
  durationMs: 50,
  status: 'success',
  cost: { usd: 0, perAgent: [] },
  subQuestions: [],
  specialists: [],
  mocked: true,
  ...overrides,
});

describe('writeRunReport', () => {
  it('writes the JSON report to the dated subdir', async () => {
    const path = await writeRunReport(tmpDir, sample());
    expect(path).toContain('runs/2026-04-26/run-1.json');
    const body = JSON.parse(await readFile(path, 'utf8')) as RunReport;
    expect(body.runId).toBe('run-1');
  });

  it('writes a sibling markdown file when a research report is supplied', async () => {
    const research = {
      summary: 's',
      markdown: '## body',
      citations: [],
    };
    const path = await writeRunReport(tmpDir, sample(), { research });
    const md = await readFile(path.replace('.json', '.md'), 'utf8');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('does not double-add a trailing newline', async () => {
    const research = { summary: 's', markdown: 'body\n', citations: [] };
    const path = await writeRunReport(tmpDir, sample(), { research });
    const md = await readFile(path.replace('.json', '.md'), 'utf8');
    expect(md).toBe('body\n');
  });
});
