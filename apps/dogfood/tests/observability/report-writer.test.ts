import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { writeRunReport } from '../../src/observability/report-writer.js';
import type { RunReport } from '../../src/types.js';

const BASE: RunReport = {
  schemaVersion: 1,
  harnessVersion: '0.1.0',
  timestamp: '2026-04-24T12:00:00.000Z',
  repository: 'a/b',
  issueNumber: 10,
  issueBodyFingerprint: 'abcdef0123456789',
  durationMs: 1234,
  status: 'success',
  cost: { usd: 0.01, inputTokens: 100, outputTokens: 50 },
  mocked: true,
};

describe('writeRunReport', () => {
  it('writes a pretty-printed JSON file under runs/<date>/<issue>.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dogfood-reports-'));
    const path = await writeRunReport(root, BASE);
    expect(path.endsWith('runs/2026-04-24/10.json')).toBe(true);
    const content = await readFile(path, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(content) as RunReport;
    expect(parsed).toEqual(BASE);
  });
});
