#!/usr/bin/env tsx
/**
 * `harness-research` CLI entry point.
 *
 * The real work lives in {@link runCli}; this file handles only argv slicing
 * and the top-level `process.exit` so the testable surface stays pure.
 */
import { runCli } from './main.js';

const isDirectInvocation = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return entry.endsWith('bin.ts') || entry.endsWith('bin.js');
};

if (isDirectInvocation()) {
  runCli({ argv: process.argv.slice(2) })
    .then((result) => {
      if (result.exitCode !== 0) process.exit(result.exitCode);
    })
    .catch((err: unknown) => {
      process.stderr.write(`[harness-research] unhandled top-level failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
}
