import { defineTool, toolSuccess, toolError, ToolCapability } from 'harness-one/tools';
import type { ToolDefinition } from 'harness-one/tools';

import type { GhRunner } from '../github/gh-cli.js';
import { listRecentIssues, rankByOverlap, type RecentIssue } from '../github/search-recent.js';

export interface SearchToolOptions {
  readonly gh: GhRunner;
  readonly repository: string;
  /**
   * If set, the tool uses this fixed list instead of shelling out. Tests
   * pass a fixture so they don't hit the network.
   */
  readonly fixedIssues?: readonly RecentIssue[];
}

/**
 * Define the `search_recent_issues` tool. The tool is read-only and capped
 * at 5 results per query to keep the agent's context small.
 */
export function defineSearchRecentIssuesTool(
  options: SearchToolOptions,
): ToolDefinition<{ query: string; topK?: number }> {
  return defineTool<{ query: string; topK?: number }>({
    name: 'search_recent_issues',
    description:
      'Search recently closed issues in this repository for potential duplicates. ' +
      'Returns up to topK (default 5) issues ranked by overlap with the query string.',
    capabilities: [ToolCapability.Readonly],
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Short keyword query drawn from the new issue title / body.',
        },
        topK: {
          type: 'integer',
          description: 'Max number of results to return (1-5).',
          minimum: 1,
          maximum: 5,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(params) {
      const topK = Math.min(Math.max(params.topK ?? 5, 1), 5);
      try {
        const issues =
          options.fixedIssues ??
          (await listRecentIssues(options.gh, {
            repository: options.repository,
            limit: 100,
            state: 'closed',
          }));
        const ranked = rankByOverlap(issues, params.query, topK);
        return toolSuccess({
          query: params.query,
          results: ranked.map((issue) => ({
            issueNumber: issue.number,
            title: issue.title,
            url: issue.url,
            state: issue.state,
            labels: issue.labels,
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(
          `search_recent_issues failed: ${message}`,
          'internal',
          'Retry the query; if this keeps happening the gh CLI may be unavailable.',
          true,
        );
      }
    },
  });
}
