import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunReport } from '../types.js';

/**
 * Write a run report to `<reportsRoot>/runs/<YYYY-MM-DD>/<issueNumber>.json`.
 * The caller supplies `reportsRoot` so tests can point at a tmp dir.
 *
 * Returns the absolute path that was written, for logging + workflow artifact
 * upload.
 */
export async function writeRunReport(
  reportsRoot: string,
  report: RunReport,
): Promise<string> {
  const day = report.timestamp.slice(0, 10); // YYYY-MM-DD from ISO string
  const dir = join(reportsRoot, 'runs', day);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${report.issueNumber}.json`);
  // Deterministic pretty-print so the file is reviewable in a PR diff.
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return path;
}
