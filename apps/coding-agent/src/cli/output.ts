/**
 * CLI rendering helpers — keep `bin.ts` declarative.
 *
 * Renderers are pure functions returning strings so they can be unit-
 * tested without spawning a process.
 *
 * @module
 */

import type { TaskResult } from '../agent/types.js';
import type { CheckpointSummary } from '../memory/checkpoint.js';
import type { EvalRunResult } from '../eval/types.js';

export function renderResult(result: TaskResult): string {
  const lines: string[] = [
    '',
    `Task ${result.taskId} → ${result.state} (${result.reason})`,
    `Iterations: ${result.iterations}    Duration: ${formatDuration(result.durationMs)}    Cost: $${result.cost.usd.toFixed(4)} (${result.cost.tokens} tokens)`,
  ];
  if (result.changedFiles.length > 0) {
    lines.push(`Changed files (${result.changedFiles.length}):`);
    for (const path of result.changedFiles) lines.push(`  - ${path}`);
  }
  if (result.errorMessage) {
    lines.push(`Error: ${result.errorMessage}`);
  }
  if (result.summary) {
    lines.push('Summary:');
    for (const ln of result.summary.split('\n')) lines.push(`  ${ln}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderCheckpointList(summaries: readonly CheckpointSummary[]): string {
  if (summaries.length === 0) return 'No checkpoints found.\n';
  const rows = summaries.map((s) => {
    const ts = new Date(s.lastUpdatedAt).toISOString();
    return `${s.taskId}\t${s.state}\titer=${s.iteration}\t${ts}\t${truncate(s.prompt, 60)}`;
  });
  return ['taskId\tstate\titeration\tlastUpdated\tprompt', ...rows, ''].join('\n');
}

export function renderJsonReport(result: TaskResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function renderEvalReport(report: EvalRunResult): string {
  const lines: string[] = [
    '',
    `Eval: ${report.passCount}/${report.cases.length} pass (${(report.passRate * 100).toFixed(1)}%)`,
    `Total cost: $${report.totalCostUsd.toFixed(4)}    Tokens: ${report.totalTokens}    Duration: ${formatDuration(report.totalDurationMs)}`,
    '',
  ];
  for (const c of report.cases) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    lines.push(
      `  [${tag}] ${c.fixtureId} (${formatDuration(c.durationMs)}, $${c.result.cost.usd.toFixed(4)})`,
    );
    if (!c.pass && c.reason) lines.push(`         ↳ ${c.reason}`);
  }
  lines.push('');
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}
