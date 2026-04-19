/**
 * PR-body rationale gate for api-extractor changes.
 *
 * When any `packages/*​/etc/*.api.md` snapshot diffs vs the PR base, the PR
 * body MUST contain a `## API change rationale` section with ≥20 chars of
 * body text. Keeps surface changes intentional; forces the author to
 * articulate WHY before reviewers see a surface diff.
 *
 * Execution (GitHub Actions): invoked after `actions/checkout` with
 * `fetch-depth: 0`; reads `GITHUB_EVENT_PATH` for the PR body and `git
 * diff` against `GITHUB_BASE_REF` to detect api.md churn. Exits non-zero
 * on failure; stdout carries the diagnostic.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const RATIONALE_HEADING = /^## API change rationale\s*$/m;
const MIN_BODY_CHARS = 20;

interface PRPayload {
  readonly pull_request?: { readonly body?: string | null };
}

function main(): void {
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  const baseRef = process.env['GITHUB_BASE_REF'];
  if (!eventPath || !baseRef) {
    console.error(
      '[check-api-rationale] GITHUB_EVENT_PATH / GITHUB_BASE_REF unset; skipping (local run)',
    );
    process.exit(0);
  }

  const changedApi = listChangedApiSnapshots(baseRef);
  if (changedApi.length === 0) {
    console.log('[check-api-rationale] No api.md diff vs base — gate skipped.');
    process.exit(0);
  }

  console.log(`[check-api-rationale] api.md snapshots touched:\n  ${changedApi.join('\n  ')}`);

  const body = readPrBody(eventPath);
  if (!RATIONALE_HEADING.test(body)) {
    console.error(
      `::error::PR body MUST contain a "## API change rationale" section when any packages/*​/etc/*.api.md changes. Touched: ${changedApi.join(', ')}`,
    );
    process.exit(1);
  }

  const match = body.match(/^## API change rationale\s*$([\s\S]*?)(?=^## |\Z)/m);
  const rationaleBody = (match?.[1] ?? '').trim();
  if (rationaleBody.length < MIN_BODY_CHARS) {
    console.error(
      `::error::"## API change rationale" body must be ≥${MIN_BODY_CHARS} chars (got ${rationaleBody.length}). Explain WHY the public surface is changing.`,
    );
    process.exit(1);
  }

  console.log(
    `[check-api-rationale] OK — rationale section present (${rationaleBody.length} chars).`,
  );
}

function listChangedApiSnapshots(baseRef: string): readonly string[] {
  const out = execSync(`git diff --name-only origin/${baseRef}...HEAD`, {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^packages\/[^/]+\/etc\/.*\.api\.md$/.test(s));
}

function readPrBody(eventPath: string): string {
  try {
    const payload = JSON.parse(readFileSync(eventPath, 'utf8')) as PRPayload;
    return payload.pull_request?.body ?? '';
  } catch (err) {
    console.error('[check-api-rationale] failed to parse event payload:', err);
    return '';
  }
}

main();
