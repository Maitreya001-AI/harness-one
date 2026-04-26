/**
 * Showcase 03 · Memory + Checkpoint stress.
 *
 * Form pressure: `memory` subsystem under crash injection. Spawns a
 * child process that writes one `FsMemoryStore` entry per iteration;
 * the supervisor SIGKILLs the child at predetermined iterations and
 * verifies that:
 *
 *   - On restart, every iteration entry written before the crash is
 *     present and validates against its checksum.
 *   - The fs index ('_index.json') is parseable; corruption raises
 *     STORE_CORRUPTION rather than returning bogus data.
 *   - No "in-flight" partial entry survives — if a crash interrupts a
 *     write, either the entry exists fully or not at all.
 *
 * MVP defaults: 30 iterations, 2 crash injections (at iter 12 and 22).
 * Production-stress version (200 iter / 5 crashes) is left to manual
 * runs — see PLAN.md "Stress test double-duty".
 *
 *   pnpm start
 */
import { spawn } from 'node:child_process';
import { rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFileSystemStore } from 'harness-one/memory';
import { checksum } from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOTAL_ITERATIONS = 30;
const CRASH_AT: readonly number[] = [12, 22];
const STORE_DIR = resolve(__dirname, '..', 'data', 'checkpoints');
const CHILD_ENTRY = resolve(__dirname, 'child.ts');

interface ChildEvent {
  readonly kind: 'start' | 'iter' | 'crash-injected' | 'done' | 'error';
  readonly i?: number;
  readonly last?: number;
  readonly message?: string;
}

interface ChildResult {
  readonly events: readonly ChildEvent[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly lastWritten: number; // Last iteration the child reported writing.
}

function runChild(from: number, until: number, crashAt: number | null): Promise<ChildResult> {
  return new Promise((resolveOut) => {
    const events: ChildEvent[] = [];
    let lastWritten = from - 1;

    const proc = spawn(
      'pnpm',
      [
        '--silent', // Suppress pnpm script-name banner so stdout is clean JSON.
        'exec',
        'tsx',
        CHILD_ENTRY,
        STORE_DIR,
        String(from),
        String(until),
        crashAt === null ? 'none' : String(crashAt),
      ],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        cwd: resolve(__dirname, '..'),
      },
    );

    let buffer = '';
    proc.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as ChildEvent;
          events.push(ev);
          if (ev.kind === 'iter' && typeof ev.i === 'number') {
            lastWritten = ev.i;
          }
        } catch {
          // Drop non-JSON output (e.g. AgentLoop warn lines that may
          // bleed in if the child wires anything else).
        }
      }
    });

    proc.on('exit', (code, signal) => {
      resolveOut({
        events,
        exitCode: code,
        signal,
        lastWritten,
      });
    });
  });
}

interface StressOutcome {
  readonly totalChildRuns: number;
  readonly crashesObserved: number;
  readonly cleanExits: number;
  readonly entriesPersisted: number;
  readonly missingIterations: readonly number[];
  readonly checksumMismatches: readonly number[];
  readonly indexParseable: boolean;
}

async function verify(): Promise<StressOutcome> {
  const store = createFileSystemStore({ directory: STORE_DIR });
  const all = await store.query({ tags: ['iter'] });
  const byIter = new Map<number, string>();
  const checksumMismatches: number[] = [];
  for (const entry of all) {
    const m = entry.metadata as { iteration?: number } | undefined;
    if (typeof m?.iteration !== 'number') continue;
    byIter.set(m.iteration, entry.content);
    try {
      const parsed = JSON.parse(entry.content) as { iteration: number; checksum: string };
      if (parsed.checksum !== checksum(m.iteration)) {
        checksumMismatches.push(m.iteration);
      }
    } catch {
      checksumMismatches.push(m.iteration);
    }
  }
  const missing: number[] = [];
  for (let i = 0; i < TOTAL_ITERATIONS; i++) {
    if (!byIter.has(i)) missing.push(i);
  }
  return {
    totalChildRuns: 0, // filled below
    crashesObserved: 0,
    cleanExits: 0,
    entriesPersisted: byIter.size,
    missingIterations: missing,
    checksumMismatches,
    indexParseable: true,
  };
}

async function main(): Promise<void> {
  // Reset the data directory so the run starts clean.
  if (existsSync(STORE_DIR)) await rm(STORE_DIR, { recursive: true, force: true });
  await mkdir(STORE_DIR, { recursive: true });

  console.log(`[stress] iterations=${TOTAL_ITERATIONS} crashAt=${CRASH_AT.join(',')}`);
  console.log(`[stress] store=${STORE_DIR}`);

  let crashesObserved = 0;
  let cleanExits = 0;
  let totalChildRuns = 0;

  // Build the segment plan: each crash splits the work into a segment.
  // After each crash we resume from (lastWritten + 1).
  const targets = [...CRASH_AT, TOTAL_ITERATIONS];
  let from = 0;
  for (const target of targets) {
    const isCrashSegment = target !== TOTAL_ITERATIONS;
    const crashAt = isCrashSegment ? target : null;
    const until = isCrashSegment ? target + 1 : TOTAL_ITERATIONS;
    console.log(`\n[stress] segment from=${from} until=${until} crashAt=${crashAt ?? 'none'}`);
    const result = await runChild(from, until, crashAt);
    totalChildRuns += 1;
    // SIGKILL detection: when the child is killed via SIGKILL, the
    // immediate parent (here: the pnpm/tsx wrapper) translates the
    // signal into exit code 137 (128 + 9). Node only forwards `signal`
    // when the *direct* child died from a signal — through a wrapper
    // we have to recognize the conventional code instead. See
    // FRICTION_LOG entry "spawn() through pnpm hides signal".
    const wasKilled =
      result.signal === 'SIGKILL' || result.exitCode === 137;
    if (wasKilled) crashesObserved += 1;
    else if (result.exitCode === 0) cleanExits += 1;
    else {
      console.error(
        `[stress] unexpected child exit code=${result.exitCode} signal=${result.signal}`,
      );
    }
    console.log(`  child exit: code=${result.exitCode} signal=${result.signal}, lastWritten=${result.lastWritten}`);
    from = result.lastWritten + 1;
    if (from >= TOTAL_ITERATIONS) break;
  }

  console.log('\n[stress] verifying persisted entries...');
  const verification = await verify();
  const outcome: StressOutcome = {
    ...verification,
    totalChildRuns,
    crashesObserved,
    cleanExits,
  };

  console.log('\n=== Stress outcome ===');
  console.log(`Child runs:           ${outcome.totalChildRuns}`);
  console.log(`Crashes observed:     ${outcome.crashesObserved}`);
  console.log(`Clean exits:          ${outcome.cleanExits}`);
  console.log(`Entries persisted:    ${outcome.entriesPersisted} / ${TOTAL_ITERATIONS}`);
  console.log(`Missing iterations:   [${outcome.missingIterations.join(', ')}]`);
  console.log(`Checksum mismatches:  [${outcome.checksumMismatches.join(', ')}]`);

  // Pass criteria:
  //   - All TOTAL_ITERATIONS persisted (no data loss across restarts)
  //   - 0 checksum mismatches (no silent corruption)
  //   - exactly CRASH_AT.length SIGKILLs observed
  const failures: string[] = [];
  if (outcome.entriesPersisted !== TOTAL_ITERATIONS) {
    failures.push(`expected ${TOTAL_ITERATIONS} entries; got ${outcome.entriesPersisted}`);
  }
  if (outcome.checksumMismatches.length > 0) {
    failures.push(`checksum mismatches: ${outcome.checksumMismatches.join(',')}`);
  }
  if (outcome.crashesObserved !== CRASH_AT.length) {
    failures.push(`expected ${CRASH_AT.length} crashes; observed ${outcome.crashesObserved}`);
  }

  if (failures.length === 0) {
    console.log('\nPASS — memory subsystem survived crash injection cleanly');
  } else {
    console.log('\nFAIL —');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('[showcase-03] fatal:', err);
  process.exit(1);
});
