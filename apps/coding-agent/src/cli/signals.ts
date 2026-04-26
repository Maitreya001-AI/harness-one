/**
 * SIGINT / SIGTERM handling for the CLI binary.
 *
 * The first signal triggers a graceful abort (the aborter signal flips,
 * which propagates into the AgentLoop and ultimately writes a final
 * checkpoint). A second signal within the grace window force-exits with
 * code 130 — matches conventional shell behaviour and stops a hung
 * process from blocking the user terminal.
 *
 * @module
 */

export interface SignalHandlerOptions {
  readonly aborter: AbortController;
  /** Grace ms after the first SIGINT — second signal force-exits. */
  readonly graceMs?: number;
  /** Override `process.kill`/`process.exit` for tests. */
  readonly exit?: (code: number) => void;
  readonly log?: (msg: string) => void;
}

export interface SignalHandle {
  readonly cleanup: () => void;
}

export function installSignalHandlers(options: SignalHandlerOptions): SignalHandle {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ??
    ((m: string) => {
       
      console.error(m);
    });
  let alreadyAborting = false;

  const handler = (signal: NodeJS.Signals) => () => {
    if (alreadyAborting) {
      log(`[coding-agent] ${signal} again — force-exiting`);
      exit(130);
      return;
    }
    alreadyAborting = true;
    log(`[coding-agent] ${signal} — aborting current task; press again to force exit`);
    options.aborter.abort();
  };

  const onSigint = handler('SIGINT');
  const onSigterm = handler('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  return {
    cleanup() {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    },
  };
}
