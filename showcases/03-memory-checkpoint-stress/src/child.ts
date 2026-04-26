/**
 * Child process for the memory-checkpoint stress showcase.
 *
 * Argv: <storeDir> <fromIteration> <untilIteration> <crashAt|none>
 *
 * Runs iterations [fromIteration..untilIteration), writing one
 * `MemoryEntry` per iteration to `FsMemoryStore`. If `crashAt` is a
 * number, the child sends a "ready" line and then SIGKILLs itself
 * AFTER writing iteration `crashAt`.
 *
 * Communication with the supervisor is via stdout JSON-lines so we don't
 * need IPC channels (which interact poorly with `process.kill(self,
 * 'SIGKILL')`).
 */
import { createFileSystemStore } from 'harness-one/memory';
import { checksum, stateKey } from './state.js';

interface Args {
  readonly storeDir: string;
  readonly fromIteration: number;
  readonly untilIteration: number;
  readonly crashAt: number | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length !== 4) {
    throw new Error(
      `child: expected 4 args (storeDir, from, until, crashAt|none), got ${argv.length}`,
    );
  }
  return {
    storeDir: argv[0]!,
    fromIteration: Number(argv[1]),
    untilIteration: Number(argv[2]),
    crashAt: argv[3] === 'none' ? null : Number(argv[3]),
  };
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const store = createFileSystemStore({ directory: args.storeDir });

  emit({ kind: 'start', from: args.fromIteration, until: args.untilIteration, crashAt: args.crashAt });

  for (let iter = args.fromIteration; iter < args.untilIteration; iter++) {
    const key = stateKey(iter);
    // Write before reading existing — `write` should overwrite by key.
    // FsMemoryStore actually keys by id (not user-supplied key); we
    // store the iteration in the entry tags so we can find it by query.
    await store.write({
      key,
      content: JSON.stringify({
        iteration: iter,
        checksum: checksum(iter),
        payloadKb: 1,
        timestampMs: Date.now(),
      }),
      grade: 'critical',
      metadata: { kind: 'iter-state', iteration: iter },
      tags: ['iter', `iter-${iter}`],
    });

    emit({ kind: 'iter', i: iter });

    if (args.crashAt === iter) {
      emit({ kind: 'crash-injected', i: iter });
      // Force-exit; do not flush stdio gracefully. SIGKILL on the
      // current PID models OOM-kill semantics.
      process.kill(process.pid, 'SIGKILL');
      // The kill is asynchronous on macOS; spin so we don't keep
      // executing in the meantime.
      await new Promise((r) => setTimeout(r, 5_000));
      return;
    }
  }

  emit({ kind: 'done', last: args.untilIteration - 1 });
  process.exit(0);
}

main().catch((err: unknown) => {
  emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
