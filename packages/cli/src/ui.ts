/**
 * ANSI color utilities for CLI output.
 *
 * @module
 */

export const SUPPORTS_COLOR =
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY ?? false);

export const c = {
  bold: (s: string) => (SUPPORTS_COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (SUPPORTS_COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (SUPPORTS_COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (SUPPORTS_COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (SUPPORTS_COLOR ? `\x1b[36m${s}\x1b[0m` : s),
  dim: (s: string) => (SUPPORTS_COLOR ? `\x1b[2m${s}\x1b[0m` : s),
};
