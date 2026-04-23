/**
 * Structured span attributes derived from HarnessError instances.
 *
 * @module
 */

import type { AgentLoopTraceManager } from './trace-interface.js';
import { HarnessError, HarnessErrorCode } from './errors.js';

const RETRYABLE_ERROR_CODES = new Set<string>([
  HarnessErrorCode.ADAPTER_RATE_LIMIT,
  HarnessErrorCode.ADAPTER_NETWORK,
  HarnessErrorCode.ADAPTER_UNAVAILABLE,
  HarnessErrorCode.ADAPTER_CIRCUIT_OPEN,
  HarnessErrorCode.CORE_TIMEOUT,
]);

export function isRetryableHarnessErrorCode(code: string): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

export function annotateHarnessErrorSpan(
  traceManager: AgentLoopTraceManager | undefined,
  spanId: string | undefined,
  error: unknown,
): void {
  if (!traceManager || !spanId || !(error instanceof HarnessError)) {
    return;
  }

  traceManager.setSpanAttributes(spanId, {
    'harness.error.code': error.code,
    'harness.error.retryable': isRetryableHarnessErrorCode(error.code),
  });
}
