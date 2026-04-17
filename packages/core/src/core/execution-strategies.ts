import type { ToolCallRequest, ExecutionStrategy, ToolExecutionResult } from './types.js';
import { HarnessError, HarnessErrorCode } from './errors.js';

/**
 * Wave-13 D-10: declaration merging adds an optional `dispose` member to the
 * structural `ExecutionStrategy` contract so long-running strategies (e.g.
 * worker pools, persistent queues) can release resources at AgentLoop
 * shutdown. The merge lives in this file — alongside the built-in strategy
 * factories — rather than in `types.ts` to avoid a cross-file behavioural
 * change; the semantics are identical for the TypeScript compiler either way.
 *
 * Existing built-in strategies (`createSequentialStrategy`, `createParallelStrategy`)
 * do not need `dispose` because they hold no per-instance resources; the
 * field stays optional so they remain source-compatible.
 *
 * AgentLoop.dispose() forwards into `strategy.dispose?.()` when present.
 */
declare module './types.js' {
  interface ExecutionStrategy {
    /**
     * Optional teardown hook. Called once by AgentLoop.dispose() (or by
     * consumers that own the strategy lifecycle). Implementations MUST be
     * idempotent — multiple dispose calls are allowed and must not throw.
     */
    dispose?(): Promise<void>;
  }
}

/**
 * Sequential execution strategy (current default behavior).
 * Executes tool calls one-by-one in order.
 */
export function createSequentialStrategy(): ExecutionStrategy {
  return {
    async execute(calls, handler) {
      const results: ToolExecutionResult[] = [];
      for (const call of calls) {
        let result: unknown;
        try {
          result = await handler(call);
        } catch (err) {
          result = {
            error: err instanceof Error ? err.message : String(err),
            ...(err instanceof Error && { errorName: err.name }),
          };
        }
        results.push({ toolCallId: call.id, result });
      }
      return results;
    },
  };
}

/**
 * Parallel execution strategy with concurrency cap.
 * - Tools marked sequential via getToolMeta run after the parallel batch
 * - Concurrency capped at maxConcurrency
 * - Results in original call order regardless of completion order
 * - Uses Promise.allSettled semantics for fault isolation
 */
export function createParallelStrategy(options?: {
  maxConcurrency?: number;
}): ExecutionStrategy {
  const maxConcurrency = options?.maxConcurrency ?? 5;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new HarnessError(
      'maxConcurrency must be a positive integer',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive integer for maxConcurrency (e.g. 5)',
    );
  }

  return {
    async execute(calls, handler, strategyOptions) {
      const getMeta = strategyOptions?.getToolMeta;
      const signal = strategyOptions?.signal;

      // Partition into parallel and sequential groups
      const parallelEntries: Array<{ index: number; call: ToolCallRequest }> = [];
      const sequentialEntries: Array<{ index: number; call: ToolCallRequest }> = [];

      for (let i = 0; i < calls.length; i++) {
        const meta = getMeta?.(calls[i].name);
        if (meta?.sequential) {
          sequentialEntries.push({ index: i, call: calls[i] });
        } else {
          parallelEntries.push({ index: i, call: calls[i] });
        }
      }

      const results: ToolExecutionResult[] = new Array(calls.length);

      // Execute parallel group with worker pool (NOT chunk-based batching!)
      if (parallelEntries.length > 0) {
        const settled = await promiseAllSettledWithConcurrency(
          parallelEntries.map(e => async () => {
            // Check abort signal before starting each tool call
            if (signal?.aborted) {
              return { error: 'Aborted' };
            }
            try {
              return await handler(e.call);
            } catch (err) {
              return {
                error: err instanceof Error ? err.message : String(err),
                ...(err instanceof Error && { errorName: err.name }),
              };
            }
          }),
          maxConcurrency,
        );

        for (let i = 0; i < parallelEntries.length; i++) {
          const entry = parallelEntries[i];
          const outcome = settled[i];
          results[entry.index] = {
            toolCallId: entry.call.id,
            result: outcome.status === 'fulfilled'
              ? outcome.value
              : {
                  error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
                  ...(outcome.reason instanceof Error && { errorName: outcome.reason.name }),
                },
          };
        }
      }

      // Execute sequential group one-by-one
      for (const entry of sequentialEntries) {
        // Check abort signal before starting each sequential tool call
        if (signal?.aborted) {
          results[entry.index] = { toolCallId: entry.call.id, result: { error: 'Aborted' } };
          continue;
        }
        let result: unknown;
        try {
          result = await handler(entry.call);
        } catch (err) {
          result = {
            error: err instanceof Error ? err.message : String(err),
            ...(err instanceof Error && { errorName: err.name }),
          };
        }
        results[entry.index] = { toolCallId: entry.call.id, result };
      }

      return results;
    },
  };
}

/**
 * Worker-pool concurrency limiter.
 * Runs at most `limit` tasks concurrently using N workers draining a shared queue.
 * This is NOT chunk-based batching — workers start new tasks as soon as they finish one.
 */
async function promiseAllSettledWithConcurrency<T>(
  factories: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(factories.length);
  // Shared by all workers. The read-modify-write `nextIndex++` is safe because
  // JS is single-threaded: the `await` on the next line is the only preemption
  // point, and by that time the increment has already completed synchronously.
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < factories.length) {
      const i = nextIndex++;
      try {
        const value = await factories[i]();
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, factories.length) },
    () => runNext(),
  );
  await Promise.all(workers);
  return results;
}
