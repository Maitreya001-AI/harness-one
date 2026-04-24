import type { GhRunner } from './gh-cli.js';

export interface RecentIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
}

/**
 * Fetch the last N issues for a repository (default: 100 closed). We fetch
 * up-front and filter in-memory rather than hammering the search API per
 * tool invocation, because a single dogfood run may search more than once
 * and the list rarely changes during a run.
 */
export async function listRecentIssues(
  gh: GhRunner,
  opts: {
    readonly repository: string;
    readonly limit?: number;
    readonly state?: 'open' | 'closed' | 'all';
  },
): Promise<readonly RecentIssue[]> {
  const limit = opts.limit ?? 100;
  const state = opts.state ?? 'closed';
  const result = await gh.run([
    'issue',
    'list',
    '--repo',
    opts.repository,
    '--state',
    state,
    '--limit',
    String(limit),
    '--json',
    'number,title,url,state,labels',
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `gh issue list exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  if (!result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => normalize(entry));
}

function normalize(entry: unknown): RecentIssue {
  const rec = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
  const labels = Array.isArray(rec['labels'])
    ? (rec['labels'] as unknown[])
        .map((l) => (l && typeof l === 'object' ? (l as Record<string, unknown>)['name'] : ''))
        .filter((n): n is string => typeof n === 'string')
    : [];
  const stateRaw = typeof rec['state'] === 'string' ? rec['state'].toLowerCase() : 'closed';
  const state = stateRaw === 'open' ? 'open' : 'closed';
  return {
    number: typeof rec['number'] === 'number' ? rec['number'] : 0,
    title: typeof rec['title'] === 'string' ? rec['title'] : '',
    url: typeof rec['url'] === 'string' ? rec['url'] : '',
    state,
    labels,
  };
}

/**
 * Simple bag-of-words scoring to rank issues against a query. Used by the
 * triage tool so the model doesn't have to re-rank.
 */
export function rankByOverlap(
  issues: readonly RecentIssue[],
  query: string,
  topK = 5,
): readonly RecentIssue[] {
  const tokens = tokenize(query);
  // No scorable tokens → no matches. Returning issues.slice() would be
  // misleading: a nonsense query would look like everything matches.
  if (tokens.size === 0) return [];
  const scored = issues.map((issue) => {
    const issueTokens = tokenize(`${issue.title} ${issue.labels.join(' ')}`);
    let score = 0;
    for (const t of tokens) {
      if (issueTokens.has(t)) score += 1;
    }
    return { issue, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((s) => s.score > 0)
    .slice(0, topK)
    .map((s) => s.issue);
}

function tokenize(input: string): Set<string> {
  const out = new Set<string>();
  for (const tok of input.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 3) out.add(tok);
  }
  return out;
}
