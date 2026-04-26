/**
 * Default command + path allowlists for the coding agent.
 *
 * Implements DESIGN §3.6 hard guardrails. Callers may extend or replace
 * these via `createCodingAgent({ guardrails: { ... } })`.
 *
 * @module
 */

/** Commands the shell tool may run by default. */
export const DEFAULT_COMMAND_ALLOWLIST: readonly string[] = Object.freeze([
  'pnpm',
  'npm',
  'yarn',
  'node',
  'tsc',
  'tsx',
  'vitest',
  'eslint',
  'prettier',
  'pytest',
  'python',
  'python3',
  'git',
]);

/**
 * Substrings that are blocked anywhere in the assembled command line.
 * Pattern matching is case-insensitive and does not anchor.
 */
export const DEFAULT_COMMAND_DENY_PATTERNS: readonly RegExp[] = Object.freeze([
  /\brm\s+-rf\s+\//i,
  /\bsudo\b/i,
  /\bsu\s/i,
  /\bchmod\s+777\b/i,
  /\bchown\s+root\b/i,
  /\b:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/i, // fork bomb
  /\bmkfs\./i,
  /\bdd\s+if=.*\s+of=\/dev\//i,
  /\bcurl\b.*\|\s*(sh|bash|zsh)\b/i,
  /\bwget\b.*\|\s*(sh|bash|zsh)\b/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bnc\s+-l\b/i,
]);

/** Reserved command names that are *always* denied regardless of allowlist. */
export const HARD_DENIED_COMMANDS: ReadonlySet<string> = new Set([
  'sudo',
  'su',
  'doas',
  'reboot',
  'shutdown',
  'halt',
  'poweroff',
  'mkfs',
  'dd',
  'rm', // rm is too dangerous as a tool primitive — use fs writers instead
]);

/**
 * Decide whether a command + args pair is allowed by the static policy.
 *
 * Returns `{ allow: true }` when the command is on the allowlist AND the
 * full command line does not match a deny pattern AND the command is not
 * in `HARD_DENIED_COMMANDS`.
 */
export function evaluateCommandPolicy(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly allowlist?: readonly string[];
  readonly denyPatterns?: readonly RegExp[];
}): { readonly allow: boolean; readonly reason?: string } {
  const allowlist = new Set(input.allowlist ?? DEFAULT_COMMAND_ALLOWLIST);
  const denyPatterns = input.denyPatterns ?? DEFAULT_COMMAND_DENY_PATTERNS;

  if (HARD_DENIED_COMMANDS.has(input.command)) {
    return {
      allow: false,
      reason: `Command "${input.command}" is hard-denied by the coding agent`,
    };
  }
  if (!allowlist.has(input.command)) {
    return {
      allow: false,
      reason: `Command "${input.command}" not in allowlist (${[...allowlist].join(', ')})`,
    };
  }
  const cmdLine = `${input.command} ${input.args.join(' ')}`;
  for (const pattern of denyPatterns) {
    if (pattern.test(cmdLine)) {
      return {
        allow: false,
        reason: `Command line matches deny pattern ${pattern}`,
      };
    }
  }
  return { allow: true };
}
