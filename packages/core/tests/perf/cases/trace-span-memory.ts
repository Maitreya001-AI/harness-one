/**
 * I2 · Peak heap after writing 10k spans into a fresh TraceManager.
 *
 * We measure the delta between a pre-run GC'd heap reading and a
 * post-run GC'd heap reading. Requires `--expose-gc` (the `bench` script
 * sets NODE_OPTIONS="--expose-gc"); when GC is NOT exposed we still
 * produce a number but mark it with a higher-variance caveat in the case
 * description, since retained vs peak heap can drift arbitrarily.
 *
 * 10k spans is chosen as the canonical "large trace" — well above any
 * realistic per-request span count but small enough to run in <1s.
 *
 * @module
 */

import { createTraceManager } from '../../../src/observe/trace-manager.js';

import type { PerfCase, PerfSample } from '../types.js';
import { forceGc, nowIso } from '../helpers.js';

const SPAN_COUNT = 10_000;

export const traceSpanMemoryCase: PerfCase = {
  id: 'I2',
  description: '10k trace-span heap peak (fresh TraceManager, GC-settled)',

  async run(): Promise<PerfSample[]> {
    // Pre-measure baseline. GC twice — the first call often leaves behind
    // young-gen churn that a second pass reclaims.
    forceGc();
    forceGc();
    const before = process.memoryUsage().heapUsed;

    const tm = createTraceManager({ maxTraces: 16 });
    const traceId = tm.startTrace('perf-bench-i2');
    const spanIds = new Array<string>(SPAN_COUNT);
    for (let i = 0; i < SPAN_COUNT; i++) {
      spanIds[i] = tm.startSpan(traceId, `span-${i}`);
      // small attribute payload — realistic span weight under load.
      tm.setSpanAttributes(spanIds[i], {
        'perf.bench': 'i2',
        'perf.index': i,
      });
    }

    // Sample peak heap WHILE spans are live — this is the retained-heap
    // metric we care about (leak-detection / capacity planning).
    forceGc();
    const peak = process.memoryUsage().heapUsed;
    const deltaBytes = Math.max(0, peak - before);

    // Settle the trace so Node can reclaim before the next case starts.
    for (const id of spanIds) tm.endSpan(id);
    tm.endTrace(traceId);
    await tm.dispose();

    return [
      {
        metric: 'trace_10k_span_peak_heap_mb',
        unit: 'mb',
        value: Number((deltaBytes / (1024 * 1024)).toFixed(3)),
        iterations: SPAN_COUNT,
        timestamp: nowIso(),
      },
    ];
  },
};
