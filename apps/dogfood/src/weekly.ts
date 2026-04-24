#!/usr/bin/env tsx
/**
 * Weekly aggregator — reads run reports from the last 7 days, emits a
 * deterministic markdown summary to `<reportsRoot>/weekly-YYYY-WW.md`.
 *
 * Intended to be invoked by `.github/workflows/dogfood-weekly.yml` after it
 * has downloaded the last week's run-report artifacts into the reports
 * directory.
 */
/* eslint-disable no-console -- CLI entry point; stdout is the product. */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { RunReport } from './types.js';

interface WeeklyStats {
  readonly totalRuns: number;
  readonly successRuns: number;
  readonly guardrailBlocked: number;
  readonly errorRuns: number;
  readonly mockRuns: number;
  readonly totalCostUsd: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly topErrorCodes: readonly { readonly code: string; readonly count: number }[];
  readonly adapters: readonly { readonly harnessVersion: string; readonly count: number }[];
}

export function computeStats(reports: readonly RunReport[]): WeeklyStats {
  const total = reports.length;
  const success = reports.filter((r) => r.status === 'success').length;
  const blocked = reports.filter((r) => r.status === 'guardrail_blocked').length;
  const errored = reports.filter((r) => r.status === 'error').length;
  const mocked = reports.filter((r) => r.mocked).length;
  const totalCost = reports.reduce((acc, r) => acc + r.cost.usd, 0);

  const latencies = reports.map((r) => r.durationMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);

  const errorCounts = new Map<string, number>();
  for (const r of reports) {
    if (r.errorCode) {
      errorCounts.set(r.errorCode, (errorCounts.get(r.errorCode) ?? 0) + 1);
    }
  }
  const topErrorCodes = Array.from(errorCounts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, 5);

  const versionCounts = new Map<string, number>();
  for (const r of reports) {
    versionCounts.set(r.harnessVersion, (versionCounts.get(r.harnessVersion) ?? 0) + 1);
  }
  const adapters = Array.from(versionCounts.entries())
    .map(([harnessVersion, count]) => ({ harnessVersion, count }))
    .sort((a, b) => b.count - a.count || a.harnessVersion.localeCompare(b.harnessVersion));

  return {
    totalRuns: total,
    successRuns: success,
    guardrailBlocked: blocked,
    errorRuns: errored,
    mockRuns: mocked,
    totalCostUsd: totalCost,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    topErrorCodes,
    adapters,
  };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx] ?? 0;
}

export function renderWeekly(
  week: { readonly year: number; readonly week: number },
  stats: WeeklyStats,
  now = new Date(),
): string {
  const generated = now.toISOString();
  const pct = (n: number, d: number): string => (d === 0 ? '0%' : `${((n / d) * 100).toFixed(1)}%`);
  const lines = [
    `# Dogfood weekly report · ${week.year}-W${String(week.week).padStart(2, '0')}`,
    '',
    `_Generated ${generated}._`,
    '',
    '## Summary',
    '',
    `- Runs: **${stats.totalRuns}**`,
    `- Success: **${stats.successRuns}** (${pct(stats.successRuns, stats.totalRuns)})`,
    `- Guardrail-blocked: ${stats.guardrailBlocked}`,
    `- Errored: ${stats.errorRuns}`,
    `- Mock runs: ${stats.mockRuns}`,
    `- Cost: **$${stats.totalCostUsd.toFixed(4)}**`,
    `- Latency p50/p95: ${stats.p50LatencyMs}ms / ${stats.p95LatencyMs}ms`,
    '',
    '## Top error codes',
    '',
  ];
  if (stats.topErrorCodes.length === 0) {
    lines.push('_None._');
  } else {
    for (const e of stats.topErrorCodes) {
      lines.push(`- \`${e.code}\` × ${e.count}`);
    }
  }
  lines.push('', '## harness-one versions', '');
  if (stats.adapters.length === 0) {
    lines.push('_None._');
  } else {
    for (const a of stats.adapters) {
      lines.push(`- \`${a.harnessVersion}\` × ${a.count}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Compute an ISO-8601 week number for a Date. Deterministic helper pulled
 * out so the entry point and tests share one implementation.
 */
export function isoWeek(date: Date): { readonly year: number; readonly week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

async function loadReports(reportsRoot: string, cutoff: number): Promise<RunReport[]> {
  const runsDir = join(reportsRoot, 'runs');
  let dayDirs: string[];
  try {
    dayDirs = await readdir(runsDir);
  } catch {
    return [];
  }
  const reports: RunReport[] = [];
  for (const day of dayDirs) {
    const dir = join(runsDir, day);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(dir, file), 'utf8');
        const parsed = JSON.parse(raw) as RunReport;
        const ts = Date.parse(parsed.timestamp);
        if (Number.isFinite(ts) && ts >= cutoff) {
          reports.push(parsed);
        }
      } catch {
        // Silently skip unreadable / malformed report files so one bad file
        // never prevents the weekly summary from being written.
      }
    }
  }
  return reports;
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<string> {
  const reportsRoot =
    env['DOGFOOD_REPORTS_ROOT'] ?? resolve(process.cwd(), 'dogfood-reports');
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const reports = await loadReports(reportsRoot, cutoff);
  const stats = computeStats(reports);
  const week = isoWeek(now);
  const body = renderWeekly(week, stats, now);
  const path = join(
    reportsRoot,
    `weekly-${week.year}-W${String(week.week).padStart(2, '0')}.md`,
  );
  await writeFile(path, body, 'utf8');
  return path;
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('weekly.ts');
if (invokedAsScript) {
  main()
    .then((path) => {
      console.log(`[dogfood] weekly report written to ${path}`);
    })
    .catch((err: unknown) => {
      console.error('[dogfood] weekly report failed:', err);
      process.exitCode = 1;
    });
}
