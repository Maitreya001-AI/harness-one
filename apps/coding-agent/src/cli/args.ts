/**
 * CLI argument parsing for `harness-coding`.
 *
 * Hand-rolled parser to avoid a yargs/commander dep. Public flags follow
 * DESIGN §4.2:
 *
 *   harness-coding "task description"
 *     [--workspace <dir>]
 *     [--model <name>]
 *     [--max-tokens <n>] [--max-iterations <n>] [--max-duration <duration>]
 *     [--budget <usd>]
 *     [--approval auto|always-ask|allowlist]
 *     [--output <file>]
 *     [--resume <taskId>]
 *     [--plan-only] [--dry-run]
 *     [--help] [--version]
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import { omitUndefined } from 'harness-one/infra';

export type ParsedApprovalMode = 'auto' | 'always-ask' | 'allowlist';

export interface ParsedArgs {
  readonly prompt: string;
  readonly workspace?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly maxIterations?: number;
  readonly maxDurationMs?: number;
  readonly budgetUsd?: number;
  readonly approval?: ParsedApprovalMode;
  readonly output?: string;
  readonly resume?: string;
  readonly planOnly: boolean;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly version: boolean;
  /** `harness-coding ls` command — list checkpoints. */
  readonly listMode: boolean;
  /** `harness-coding eval` command — run the eval harness. */
  readonly evalMode: boolean;
  /** Tag filter applied to `harness-coding eval`. Repeatable. */
  readonly evalTags: readonly string[];
}

export const HELP_TEXT = `harness-coding — autonomous coding agent built on harness-one.

Usage:
  harness-coding [options] "<task description>"
  harness-coding ls                          # list checkpoints
  harness-coding eval [--tag <name>]         # run the eval harness
  harness-coding --resume <taskId>           # resume a checkpoint

Options:
  --workspace <dir>          Workspace root (default: cwd)
  --model <name>             Model name passed to adapter
  --max-tokens <n>           Token budget (default: 200000)
  --max-iterations <n>       Iteration budget (default: 100)
  --max-duration <duration>  Wall-clock budget, e.g. 30m, 90s, 1500ms (default: 30m)
  --budget <usd>             Soft cost budget in USD (informational)
  --approval <mode>          auto | always-ask | allowlist (default: always-ask)
  --output <file>            Write completion report to <file>
  --resume <taskId>          Resume from checkpoint
  --plan-only                Build a plan but do not execute
  --dry-run                  Run without mutating files / shell
  --help, -h                 Show this help
  --version, -v              Show version
`;

const APPROVAL_MODES: readonly ParsedApprovalMode[] = ['auto', 'always-ask', 'allowlist'];

/** Parse an argv-after-bin array. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let workspace: string | undefined;
  let model: string | undefined;
  let maxTokens: number | undefined;
  let maxIterations: number | undefined;
  let maxDurationMs: number | undefined;
  let budgetUsd: number | undefined;
  let approval: ParsedApprovalMode | undefined;
  let output: string | undefined;
  let resume: string | undefined;
  let planOnly = false;
  let dryRun = false;
  let help = false;
  let version = false;
  let listMode = false;
  let evalMode = false;
  const evalTags: string[] = [];
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--version':
      case '-v':
        version = true;
        break;
      case '--plan-only':
        planOnly = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--workspace':
        workspace = takeValue(argv, ++i, token);
        break;
      case '--model':
        model = takeValue(argv, ++i, token);
        break;
      case '--max-tokens':
        maxTokens = parseInt(takeValue(argv, ++i, token), token);
        break;
      case '--max-iterations':
        maxIterations = parseInt(takeValue(argv, ++i, token), token);
        break;
      case '--max-duration':
        maxDurationMs = parseDuration(takeValue(argv, ++i, token), token);
        break;
      case '--budget':
        budgetUsd = parseFloatStrict(takeValue(argv, ++i, token), token);
        break;
      case '--approval':
        approval = parseApproval(takeValue(argv, ++i, token));
        break;
      case '--output':
        output = takeValue(argv, ++i, token);
        break;
      case '--resume':
        resume = takeValue(argv, ++i, token);
        break;
      case '--tag':
        evalTags.push(takeValue(argv, ++i, token));
        break;
      default:
        if (token.startsWith('--')) {
          throw err(`Unknown option: ${token}`);
        }
        positional.push(token);
    }
  }

  if (positional[0] === 'ls') {
    listMode = true;
    positional.shift();
  } else if (positional[0] === 'eval') {
    evalMode = true;
    positional.shift();
  }

  const prompt = positional.join(' ');

  return {
    ...omitUndefined({
      workspace,
      model,
      maxTokens,
      maxIterations,
      maxDurationMs,
      budgetUsd,
      approval,
      output,
      resume,
    }),
    prompt,
    planOnly,
    dryRun,
    help,
    version,
    listMode,
    evalMode,
    evalTags,
  };
}

function takeValue(argv: readonly string[], i: number, flag: string): string {
  if (i >= argv.length) throw err(`Flag ${flag} requires a value`);
  const v = argv[i];
  if (v.startsWith('--')) throw err(`Flag ${flag} requires a value, got ${v}`);
  return v;
}

function parseInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw err(`${flag} must be a positive integer; got ${raw}`);
  }
  return n;
}

function parseFloatStrict(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw err(`${flag} must be a non-negative number; got ${raw}`);
  }
  return n;
}

const DURATION_PATTERN = /^(\d+)(ms|s|m|h)?$/;

export function parseDuration(raw: string, flag = '--max-duration'): number {
  const match = DURATION_PATTERN.exec(raw);
  if (!match) {
    throw err(`${flag} must be e.g. 30m, 90s, 1500ms; got ${raw}`);
  }
  const n = Number(match[1]);
  const unit = match[2] ?? 'ms';
  switch (unit) {
    case 'ms':
      return n;
    case 's':
      return n * 1_000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    default:
      throw err(`Unknown unit "${unit}" in ${flag}`);
  }
}

function parseApproval(raw: string): ParsedApprovalMode {
  if (!APPROVAL_MODES.includes(raw as ParsedApprovalMode)) {
    throw err(`--approval must be one of ${APPROVAL_MODES.join(', ')}; got ${raw}`);
  }
  return raw as ParsedApprovalMode;
}

function err(msg: string): HarnessError {
  return new HarnessError(
    msg,
    HarnessErrorCode.CORE_INVALID_INPUT,
    'Run `harness-coding --help` for the full flag list',
  );
}
