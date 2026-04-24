import type { GhRunner } from './gh-cli.js';

/**
 * Post a comment to an issue. Uses `gh issue comment <number> -F -` so the
 * body is piped through stdin — no shell interpolation of back-ticks or
 * command substitutions inside the body.
 */
export async function postIssueComment(
  gh: GhRunner,
  opts: {
    readonly repository: string;
    readonly issueNumber: number;
    readonly body: string;
  },
): Promise<void> {
  const result = await gh.run(
    [
      'issue',
      'comment',
      String(opts.issueNumber),
      '--repo',
      opts.repository,
      '-F',
      '-',
    ],
    { stdin: opts.body },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `gh issue comment exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
}

/**
 * Apply labels to an issue. No-op if labels is empty.
 *
 * We pass `--add-label` once per label so partial failures are clear in the
 * workflow log instead of being masked by a bulk invocation.
 */
export async function applyLabels(
  gh: GhRunner,
  opts: {
    readonly repository: string;
    readonly issueNumber: number;
    readonly labels: readonly string[];
  },
): Promise<void> {
  if (opts.labels.length === 0) return;
  const flags = opts.labels.flatMap((l) => ['--add-label', l]);
  const result = await gh.run([
    'issue',
    'edit',
    String(opts.issueNumber),
    '--repo',
    opts.repository,
    ...flags,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `gh issue edit exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
}
