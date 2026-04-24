import type { TriageVerdict } from '../types.js';

export interface CommentContext {
  readonly harnessVersion: string;
  readonly traceId: string | undefined;
  readonly costUsd: number;
  readonly mocked: boolean;
}

const DISCLAIMER =
  '<sub>Automated triage by the harness-one dogfood bot. ' +
  'Suggestions are machine-generated and may be wrong — a human will review.</sub>';

function renderLabels(labels: readonly string[]): string {
  if (labels.length === 0) return '_No label suggestion._';
  return labels.map((l) => `\`${l}\``).join(' ');
}

function renderDuplicates(verdict: TriageVerdict): string {
  if (verdict.duplicates.length === 0) {
    return '_No likely duplicate in the last 100 closed issues._';
  }
  const rows = verdict.duplicates.map(
    (d) => `- [#${d.issueNumber} ${d.title}](${d.url}) — confidence: \`${d.confidence}\``,
  );
  return rows.join('\n');
}

function renderReproSteps(steps: readonly string[]): string {
  if (steps.length === 0) return '_The bot could not propose repro steps from the body._';
  return steps.map((s) => `- ${s}`).join('\n');
}

/**
 * Render a GitHub issue comment body for a {@link TriageVerdict}.
 *
 * Output is deterministic for a given (verdict, context) pair so snapshot
 * tests stay stable, and it always includes the mandatory disclaimer plus
 * a footer with `traceId` + cost for traceability.
 */
export function renderTriageComment(
  verdict: TriageVerdict,
  ctx: CommentContext,
): string {
  const mockTag = ctx.mocked ? ' · mock run (no live LLM call)' : '';
  const trace = ctx.traceId ? ` · trace \`${ctx.traceId}\`` : '';
  return [
    '### :robot: Automated triage',
    '',
    `**Suggested labels:** ${renderLabels(verdict.suggestedLabels)}`,
    '',
    '**Possible duplicates:**',
    renderDuplicates(verdict),
    '',
    '**Repro hints the issue author can try:**',
    renderReproSteps(verdict.reproSteps),
    '',
    `> ${verdict.rationale}`,
    '',
    '---',
    '',
    `<sub>harness-one \`${ctx.harnessVersion}\` · cost \`$${ctx.costUsd.toFixed(4)}\`${trace}${mockTag}</sub>`,
    '',
    DISCLAIMER,
    '',
  ].join('\n');
}
