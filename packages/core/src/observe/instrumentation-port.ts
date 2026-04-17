/**
 * Re-export of the canonical {@link InstrumentationPort} that now lives
 * in L2 (`core/core/instrumentation-port.ts`). Kept here for backward
 * compatibility; new code should import from `../core/instrumentation-port.js`.
 *
 * @module
 */
export type { InstrumentationPort } from '../core/instrumentation-port.js';
