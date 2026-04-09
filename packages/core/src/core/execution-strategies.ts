import type { ToolCallRequest, ExecutionStrategy, ToolExecutionResult } from './types.js';

/**
 * Sequential execution strategy (current default behavior).
 * Executes tool calls one-by-one in order.
 */
export function createSequentialStrategy(): ExecutionStrategy {
  return {
    async execute(calls, handler, _options) {
      const results: ToolExecutionResult[] = [];
      for (const call of calls) {
        let result: unknown;
        try {
          result = await handler(call);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
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

  return {
    async execute(calls, handler, strategyOptions) {
      const getMeta = strategyOptions?.getToolMeta;

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
            try {
              return await handler(e.call);
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
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
              : { error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) },
          };
        }
      }

      // Execute sequential group one-by-one
      for (const entry of sequentialEntries) {
        let result: unknown;
        try {
          result = await handler(entry.call);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
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
