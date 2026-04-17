/**
 * The {@link InstrumentationPort} type surfaced via `harness-one/observe`
 * for ergonomics — the canonical L2 home is `../core/instrumentation-port.js`,
 * but consumers writing exporters naturally reach for the observe barrel
 * and expect the tracing port alongside `TraceManager` / `TraceExporter`.
 *
 * @module
 */
export type { InstrumentationPort } from '../core/instrumentation-port.js';
