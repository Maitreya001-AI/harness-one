/**
 * Perf-bench runner.
 *
 * Usage (via package.json scripts):
 *   pnpm bench                 # run all cases, compare vs baseline.json, gate on ±15 %
 *   pnpm bench --case=I1       # run a single case
 *   pnpm bench:update          # run all cases and overwrite baseline.json (owner-only)
 *
 * Gate semantics:
 *   - metric +15 % or slower        → fail (perf regression)
 *   - metric −15 % or faster        → warn (likely a benchmark-logic bug,
 *                                       not a genuine speedup)
 *   - UPDATE_BASELINE=1             → skip the gate, overwrite baseline.json
 *
 * Only Ubuntu + Node 20 numbers are committed to baseline.json; other
 * platforms show a table but exit 0.
 *
 * @module
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PerfCase, PerfSample } from './types.js';
import { agentloopOverheadCase } from './cases/agentloop-overhead.js';
import { traceSpanMemoryCase } from './cases/trace-span-memory.js';
import { filesystemStoreCase } from './cases/filesystem-store.js';
import { streamAggregatorCase } from './cases/stream-aggregator.js';
import { guardrailPipelineCase } from './cases/guardrail-pipeline.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, 'baseline.json');
const TOLERANCE = 0.15;

const CASES: PerfCase[] = [
  agentloopOverheadCase,
  traceSpanMemoryCase,
  filesystemStoreCase,
  streamAggregatorCase,
  guardrailPipelineCase,
];

interface BaselineFile {
  readonly samples: PerfSample[];
  readonly platform?: string;
  readonly nodeVersion?: string;
  readonly updatedAt?: string;
}

interface Drift {
  readonly metric: string;
  readonly baseline: number;
  readonly current: number;
  readonly deltaPct: number;
  readonly severity: 'fail' | 'warn';
}

function parseArgs(argv: string[]): { filter?: string } {
  const filter = argv.find((a) => a.startsWith('--case='));
  return filter ? { filter: filter.slice('--case='.length) } : {};
}

function readBaseline(): BaselineFile | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  try {
    const raw = readFileSync(BASELINE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as BaselineFile;
    return parsed;
  } catch {
    return undefined;
  }
}

function compare(current: PerfSample[], baseline: PerfSample[]): Drift[] {
  const byMetric = new Map(baseline.map((s) => [s.metric, s]));
  const drifts: Drift[] = [];
  for (const cur of current) {
    const base = byMetric.get(cur.metric);
    if (!base) continue; // new metric — not a drift, just a new baseline entry
    if (base.value === 0) continue; // avoid div-by-zero, treat as informational
    const delta = (cur.value - base.value) / base.value;
    if (delta > TOLERANCE) {
      drifts.push({
        metric: cur.metric,
        baseline: base.value,
        current: cur.value,
        deltaPct: delta * 100,
        severity: 'fail',
      });
    } else if (delta < -TOLERANCE) {
      drifts.push({
        metric: cur.metric,
        baseline: base.value,
        current: cur.value,
        deltaPct: delta * 100,
        severity: 'warn',
      });
    }
  }
  return drifts;
}

function formatValue(v: number, unit: string): string {
  // Compact rendering for the human table — keep ≤4 significant digits so
  // long numbers don't blow out column widths in the GitHub summary.
  if (unit === 'ns' && v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}ms`;
  if (unit === 'ns' && v >= 1_000) return `${(v / 1_000).toFixed(2)}µs`;
  if (unit === 'us' && v >= 1_000) return `${(v / 1_000).toFixed(2)}ms`;
  if (v >= 100) return `${v.toFixed(1)}${unit}`;
  return `${v.toFixed(3)}${unit}`;
}

function renderTable(
  rows: Array<{
    metric: string;
    unit: string;
    baseline: number | undefined;
    current: number;
    deltaPct: number | undefined;
  }>,
): string {
  const header = ['metric', 'baseline', 'current', 'diff'];
  const body = rows.map((r) => [
    r.metric,
    r.baseline === undefined ? '—' : formatValue(r.baseline, r.unit),
    formatValue(r.current, r.unit),
    r.deltaPct === undefined ? '—' : `${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`,
  ]);
  // Column widths keep the markdown table readable in a terminal. GitHub
  // renders the same source as a proper table in the step summary.
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((b) => b[i].length)),
  );
  const pad = (cells: string[]): string =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  const sep = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;
  return [pad(header), sep, ...body.map(pad)].join('\n');
}

async function main(): Promise<void> {
  const { filter } = parseArgs(process.argv.slice(2));
  const update = process.env['UPDATE_BASELINE'] === '1';
  const cases = filter ? CASES.filter((c) => c.id === filter) : CASES;
  if (cases.length === 0) {
    console.error(`No case matched filter '${filter ?? ''}'`);
    process.exit(2);
  }

  const current: PerfSample[] = [];
  for (const c of cases) {
    const t0 = performance.now();
    process.stdout.write(`→ ${c.id}: ${c.description}\n`);
    const samples = await c.run();
    current.push(...samples);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    for (const s of samples) {
      process.stdout.write(`    ${s.metric} = ${s.value.toFixed(3)} ${s.unit}\n`);
    }
    process.stdout.write(`  done in ${dt}s\n`);
  }

  const baseline = readBaseline();

  if (update) {
    const payload: BaselineFile = {
      samples: current,
      platform: process.platform,
      nodeVersion: process.version,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    process.stdout.write(`\nbaseline.json updated (${current.length} metrics)\n`);
    return;
  }

  if (!baseline) {
    process.stdout.write(
      '\nNo baseline.json found — run `pnpm bench:update` to create one.\n',
    );
    // First-run convenience: emit a table so the owner sees what numbers
    // they're about to freeze. No drift, no gate, exit 0.
    const rows = current.map((s) => ({
      metric: s.metric,
      unit: s.unit,
      baseline: undefined,
      current: s.value,
      deltaPct: undefined,
    }));
    process.stdout.write('\n' + renderTable(rows) + '\n');
    return;
  }

  // Drift comparison is only meaningful when the current platform matches
  // the baseline platform — filesystem / JIT / memory-allocator differences
  // between OSes swing some metrics 3-10× and would trip the gate on every
  // PR. We still render the table for visibility on non-matching hosts but
  // skip the ±15% gate (and the GitHub summary status badge flags it).
  const currentPlatform = `${process.platform}-${process.version.split('.')[0]}`;
  const baselinePlatform =
    baseline.platform && baseline.nodeVersion
      ? `${baseline.platform}-${baseline.nodeVersion.split('.')[0]}`
      : undefined;
  const platformMatches =
    baselinePlatform === undefined || baselinePlatform === currentPlatform;

  const drifts = platformMatches ? compare(current, baseline.samples) : [];
  const baselineByMetric = new Map(baseline.samples.map((s) => [s.metric, s]));
  const rows = current.map((s) => {
    const b = baselineByMetric.get(s.metric);
    return {
      metric: s.metric,
      unit: s.unit,
      baseline: b?.value,
      current: s.value,
      deltaPct:
        b === undefined || b.value === 0 ? undefined : ((s.value - b.value) / b.value) * 100,
    };
  });
  const table = renderTable(rows);
  process.stdout.write('\n' + table + '\n');

  if (!platformMatches) {
    process.stdout.write(
      `\nPlatform mismatch — baseline was recorded on ${baselinePlatform}, ` +
        `current is ${currentPlatform}. Gate skipped; table is informational only.\n`,
    );
  }

  // GitHub Step Summary — written by perf.yml via GITHUB_STEP_SUMMARY env.
  const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryPath) {
    const status = !platformMatches
      ? ':information_source: platform mismatch — gate skipped'
      : drifts.some((d) => d.severity === 'fail')
        ? ':red_circle: perf regression'
        : drifts.length > 0
          ? ':warning: perf anomaly'
          : ':white_check_mark: within ±15% tolerance';
    const body = `## Perf bench\n\n${status}\n\n${table}\n`;
    writeFileSync(summaryPath, body, { flag: 'a', encoding: 'utf8' });
  }

  const failures = drifts.filter((d) => d.severity === 'fail');
  const warnings = drifts.filter((d) => d.severity === 'warn');
  if (warnings.length > 0) {
    process.stdout.write(
      `\nWARN — ${warnings.length} metric(s) faster than baseline by >${(
        TOLERANCE * 100
      ).toFixed(0)}%; verify the benchmark is still measuring the real thing:\n`,
    );
    for (const d of warnings) {
      process.stdout.write(
        `  ${d.metric}: ${d.deltaPct.toFixed(1)}% (baseline=${d.baseline}, current=${d.current})\n`,
      );
    }
  }
  if (failures.length > 0) {
    process.stdout.write(
      `\nFAIL — ${failures.length} metric(s) regressed by >${(TOLERANCE * 100).toFixed(0)}%:\n`,
    );
    for (const d of failures) {
      process.stdout.write(
        `  ${d.metric}: +${d.deltaPct.toFixed(1)}% (baseline=${d.baseline}, current=${d.current})\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write('\nAll metrics within ±15% of baseline.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
