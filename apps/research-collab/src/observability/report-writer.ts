import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResearchReport } from '../types.js';
import type { RunReport } from '../types.js';

/**
 * Persist a {@link RunReport} (and optional rendered markdown) under
 * `<reportsRoot>/runs/<YYYY-MM-DD>/<runId>.json` plus a sibling
 * `<runId>.md` containing the markdown body when supplied. Returns the JSON
 * path for logging and CI artifact upload.
 */
export async function writeRunReport(
  reportsRoot: string,
  report: RunReport,
  options?: { readonly research?: ResearchReport },
): Promise<string> {
  const day = report.timestamp.slice(0, 10); // YYYY-MM-DD from ISO
  const dir = join(reportsRoot, 'runs', day);
  await mkdir(dir, { recursive: true });

  const jsonPath = join(dir, `${report.runId}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  if (options?.research) {
    const mdPath = join(dir, `${report.runId}.md`);
    await writeFile(mdPath, options.research.markdown.endsWith('\n') ? options.research.markdown : options.research.markdown + '\n', 'utf8');
  }

  return jsonPath;
}
