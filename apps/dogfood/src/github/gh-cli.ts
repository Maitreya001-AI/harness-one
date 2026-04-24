import { spawn } from 'node:child_process';

/**
 * Minimal async wrapper around the `gh` CLI binary.
 *
 * Deliberately does NOT shell-interpret its arguments: `spawn` is invoked
 * with an argv array so issue bodies with backticks or `$(...)` can't be
 * reinterpreted. The caller passes the CLI flags it wants, we pass them
 * through unchanged.
 *
 * In dry-run mode the command is recorded but never executed — the caller
 * can still assert on the command shape in tests.
 */
export interface GhResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GhRunner {
  run(args: readonly string[], options?: { stdin?: string }): Promise<GhResult>;
}

export function createGhRunner(options: {
  readonly dryRun?: boolean;
  readonly onCommand?: (argv: readonly string[]) => void;
} = {}): GhRunner {
  return {
    async run(args, runOptions) {
      options.onCommand?.(args);
      if (options.dryRun) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return await spawnGh(args, runOptions?.stdin);
    },
  };
}

function spawnGh(args: readonly string[], stdin?: string): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code ?? 0,
      });
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}
