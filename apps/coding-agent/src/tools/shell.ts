/**
 * `shell` tool — bounded subprocess executor.
 *
 * Hard guardrails:
 *   - cwd pinned to workspace
 *   - command must match `commandAllowlist` (DESIGN §3.6)
 *   - argv-style only (no shell interpolation by default)
 *   - timeout
 *
 * Soft guardrails:
 *   - `ctx.requireApproval` consulted for every call unless approval mode is
 *     `auto` (caller wires that decision in)
 *
 * In `dryRun` mode the subprocess is not spawned; the tool returns a record
 * describing what would have run.
 *
 * Capability: `shell`.
 *
 * @module
 */

import { spawn } from 'node:child_process';

import {
  ToolCapability,
  defineTool,
  toolError,
  toolSuccess,
} from 'harness-one/tools';
import type { ToolDefinition } from 'harness-one/tools';

import type { ToolContext } from './context.js';

export interface ShellOptions {
  /** Whitelisted argv[0] commands. Empty array means: deny everything. */
  readonly commandAllowlist: readonly string[];
  /** Per-call timeout (ms). Defaults to `ctx.defaultTimeoutMs`. */
  readonly defaultTimeoutMs?: number;
  /** Maximum bytes captured from stdout/stderr. */
  readonly maxOutputBytes?: number;
  /**
   * Test seam — supply a custom spawner so unit tests can run without
   * spawning real subprocesses.
   */
  readonly spawner?: typeof spawn;
}

interface ShellInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  /** Workspace-relative cwd; defaults to workspace root. */
  readonly cwd?: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export function defineShellTool(
  ctx: ToolContext,
  options: ShellOptions,
): ToolDefinition<ShellInput> {
  const timeoutDefault = options.defaultTimeoutMs ?? ctx.defaultTimeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const spawner = options.spawner ?? spawn;
  const allowed = new Set(options.commandAllowlist);

  return defineTool<ShellInput>({
    name: 'shell',
    description:
      'Run a workspace-rooted shell command via argv (no shell interpolation). ' +
      'Only allowlisted commands run; everything else is denied. ' +
      'Refuses to mutate state in dry-run mode.',
    capabilities: [ToolCapability.Shell],
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Argv[0] — must be in the allowlist.', minLength: 1 },
        args: {
          type: 'array',
          description: 'Argv[1..]. No shell interpolation is applied.',
          items: { type: 'string' },
        },
        timeoutMs: {
          type: 'integer',
          description: 'Per-call timeout in milliseconds (1..600000).',
          minimum: 1,
          maximum: 600_000,
        },
        cwd: {
          type: 'string',
          description: 'Workspace-relative cwd. Defaults to workspace root.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async execute(params, externalSignal) {
      if (!allowed.has(params.command)) {
        return toolError(
          `Shell command not in allowlist: ${params.command}`,
          'permission',
          `Allowlist: ${[...allowed].join(', ') || '(empty)'}`,
          false,
        );
      }
      const reason = `${params.command} ${(params.args ?? []).join(' ')}`.trim();
      if (ctx.requireApproval) {
        const approved = await ctx.requireApproval({
          toolName: 'shell',
          arguments: { command: params.command, args: params.args ?? [] },
          reason,
        });
        if (!approved.allow) {
          return toolError(
            `shell denied by approval: ${approved.reason ?? 'no reason given'}`,
            'permission',
            'Adjust the approval policy or rephrase the command',
            false,
          );
        }
      }

      const cwd = ctx.workspace; // path-safety would be needed if cwd were exposed.
      void params.cwd; // Reserved for future workspace-scoped subdir support.

      if (ctx.dryRun) {
        return toolSuccess({
          dryRun: true,
          command: params.command,
          args: params.args ?? [],
          cwd,
        });
      }

      const timeoutMs = Math.min(params.timeoutMs ?? timeoutDefault, 600_000);
      const runArgs: RunArgs = {
        spawner,
        command: params.command,
        args: params.args ?? [],
        cwd,
        timeoutMs,
        maxOutputBytes,
        ...(externalSignal !== undefined && { externalSignal }),
      };
      return runOnce(runArgs);
    },
  });
}

interface RunArgs {
  readonly spawner: typeof spawn;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly externalSignal?: AbortSignal;
}

async function runOnce(opts: RunArgs): ReturnType<ToolDefinition<ShellInput>['execute']> {
  return new Promise((resolve) => {
    const child = opts.spawner(opts.command, [...opts.args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      // Drop env vars that look secret-ish; keep PATH/HOME so commands work.
      env: redactedEnv(process.env),
    });

    let stdout = '';
    let stderr = '';
    let stdoutTrunc = false;
    let stderrTrunc = false;

    const cap = (slot: 'stdout' | 'stderr', chunk: Buffer): void => {
      const next = (slot === 'stdout' ? stdout : stderr) + chunk.toString('utf8');
      if (next.length > opts.maxOutputBytes) {
        if (slot === 'stdout') {
          stdout = next.slice(0, opts.maxOutputBytes);
          stdoutTrunc = true;
        } else {
          stderr = next.slice(0, opts.maxOutputBytes);
          stderrTrunc = true;
        }
        return;
      }
      if (slot === 'stdout') stdout = next;
      else stderr = next;
    };

    child.stdout?.on('data', (c: Buffer) => cap('stdout', c));
    child.stderr?.on('data', (c: Buffer) => cap('stderr', c));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate to SIGKILL if the process refuses to die in 2s.
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, opts.timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    opts.externalSignal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      opts.externalSignal?.removeEventListener('abort', onAbort);
      resolve(
        toolError(
          `shell spawn failed: ${err.message}`,
          'internal',
          'Verify the command is installed and on PATH',
          false,
        ),
      );
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.externalSignal?.removeEventListener('abort', onAbort);
      if (timedOut) {
        resolve(
          toolError(
            `shell timed out after ${opts.timeoutMs}ms`,
            'timeout',
            'Increase timeoutMs or simplify the command',
            true,
          ),
        );
        return;
      }
      resolve(
        toolSuccess({
          command: opts.command,
          args: [...opts.args],
          cwd: opts.cwd,
          exitCode: code ?? null,
          signal: signal ?? null,
          stdout,
          stderr,
          stdoutTruncated: stdoutTrunc,
          stderrTruncated: stderrTrunc,
        }),
      );
    });
  });
}

const SECRET_ENV_KEYS: readonly RegExp[] = [
  /TOKEN/i,
  /API[_-]?KEY/i,
  /SECRET/i,
  /PASSWORD/i,
  /PRIVATE[_-]?KEY/i,
  /AWS_ACCESS_KEY/i,
  /AWS_SECRET/i,
  /ANTHROPIC_API_KEY/i,
  /OPENAI_API_KEY/i,
];

/** Strip likely secrets so subprocess can't `printenv` and exfiltrate them. */
function redactedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_KEYS.some((p) => p.test(key))) continue;
    out[key] = value;
  }
  return out;
}
