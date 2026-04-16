/**
 * Graceful shutdown handler for harness instances.
 *
 * Registers SIGTERM/SIGINT listeners that drain the harness and dispose
 * resources in the correct order. Provides a one-liner to make any harness
 * production-ready for containerized environments (k8s, Docker, etc.).
 *
 * @module
 */

import type { Harness } from './index.js';

/** Options for the shutdown handler. */
export interface ShutdownHandlerOptions {
  /**
   * Maximum time (ms) to wait for in-flight work to complete before
   * force-exiting. Default: 30_000 (30 seconds).
   */
  readonly timeoutMs?: number;
  /**
   * Exit code to use on clean shutdown. Default: 0.
   */
  readonly exitCode?: number;
  /**
   * If `true`, calls `process.exit()` after shutdown completes.
   * Default: `true`. Set to `false` for testing or if the caller
   * manages its own exit logic.
   */
  readonly exit?: boolean;
  /**
   * Custom logger for shutdown events. Falls back to console.error
   * for maximum reliability during shutdown (structured logger may
   * already be disposed).
   */
  readonly onEvent?: (message: string) => void;
}

/**
 * Register SIGTERM and SIGINT handlers that gracefully shut down the harness.
 *
 * Returns a cleanup function that removes the registered listeners — useful
 * in tests or when the harness is re-created during the process lifetime.
 *
 * @example
 * ```ts
 * import { createSecurePreset } from '@harness-one/preset';
 * import { createShutdownHandler } from '@harness-one/preset/shutdown';
 *
 * const harness = createSecurePreset({ ... });
 * const removeHandlers = createShutdownHandler(harness, { timeoutMs: 15_000 });
 * ```
 */
export function createShutdownHandler(
  harness: Pick<Harness, 'drain'>,
  options?: ShutdownHandlerOptions,
): () => void {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const exitCode = options?.exitCode ?? 0;
  const shouldExit = options?.exit ?? true;
  const log = options?.onEvent ?? ((m: string) => {
    // eslint-disable-next-line no-console -- intentional: structured logger may be disposed
    console.error(m);
  });

  let shuttingDown = false;

  const handler = (signal: string): void => {
    if (shuttingDown) {
      log(`[harness-one] Received ${signal} again during shutdown — forcing exit`);
      if (shouldExit) process.exit(1);
      return;
    }
    shuttingDown = true;
    log(`[harness-one] Received ${signal} — draining harness (timeout: ${timeoutMs}ms)`);

    void harness.drain(timeoutMs).then(
      () => {
        log('[harness-one] Graceful shutdown complete');
        if (shouldExit) process.exit(exitCode);
      },
      (err: unknown) => {
        log(`[harness-one] Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
        if (shouldExit) process.exit(1);
      },
    );
  };

  const onSigterm = (): void => handler('SIGTERM');
  const onSigint = (): void => handler('SIGINT');

  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  return () => {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  };
}
