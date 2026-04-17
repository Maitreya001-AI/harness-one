/**
 * Trace-exporter factory helper — builds the default exporter list for a
 * {@link HarnessConfig}. Extracted from the monolithic `index.ts`; behavior
 * unchanged.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import type { TraceExporter } from 'harness-one/observe';
import { createConsoleExporter } from 'harness-one/observe';
import { createLangfuseExporter } from '@harness-one/langfuse';

import type { HarnessConfig } from './types.js';

/**
 * Pick the default {@link TraceExporter} set based on the caller's
 * configuration.
 *
 * - When `config.langfuse` is provided, its client shape is validated and a
 *   Langfuse exporter is returned. A malformed client (missing `trace()`)
 *   fails fast at construction rather than silently swallowing exports at
 *   flush time.
 * - Otherwise a {@link createConsoleExporter} is returned so traces remain
 *   observable out of the box.
 */
export function createExporters(config: HarnessConfig): TraceExporter[] {
  if (config.langfuse) {
    // Validate the client shape up front so misconfiguration fails fast at
    // harness construction rather than at flush time, when the user has
    // already started serving traffic. Langfuse clients expose `trace()`
    // and `event()` methods; a plain object or a Promise will silently swallow
    // exports until first flush.
    const client = config.langfuse as unknown as { trace?: unknown; event?: unknown };
    if (!client || typeof client !== 'object' || typeof client.trace !== 'function') {
      throw new HarnessError(
        'config.langfuse is not a valid Langfuse client (expected object with .trace() method). ' +
        'If you received a Promise, await it before passing to createHarness.',
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Construct the Langfuse client synchronously and pass the resolved instance',
      );
    }
    return [createLangfuseExporter({ client: config.langfuse })];
  }
  return [createConsoleExporter()];
}
