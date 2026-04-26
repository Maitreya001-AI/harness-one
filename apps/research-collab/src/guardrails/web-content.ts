/**
 * Guardrail wrapper for fetched web content.
 *
 * Per DESIGN §8 Open Question 7: prompt-injection on fetched HTML is
 * **mandatory** for the MVP, since web pages are an untrusted boundary the
 * Specialist will paste into the LLM context.
 *
 * We delegate to {@link createInjectionDetector} from the guardrails
 * subsystem and expose the verdict in a shape the web-fetch tool can act on
 * (block + return tool error vs. allow).
 */

import { createInjectionDetector } from 'harness-one/guardrails';
import type { GuardrailVerdict } from 'harness-one/guardrails';

export interface WebContentGuardrail {
  inspect(content: string, contextHint?: string): GuardrailVerdict;
}

export interface WebContentGuardrailOptions {
  readonly sensitivity?: 'low' | 'medium' | 'high';
}

/**
 * Build the web-content guardrail. The default sensitivity matches the
 * `'standard'` SecurePreset level so a Specialist behaves consistently with
 * the harness pipeline that wraps it.
 */
export function createWebContentGuardrail(
  options: WebContentGuardrailOptions = {},
): WebContentGuardrail {
  const detector = createInjectionDetector({
    sensitivity: options.sensitivity ?? 'medium',
  });

  return {
    inspect(content: string, contextHint?: string): GuardrailVerdict {
      // The injection detector is synchronous (returns a Verdict, not a
      // Promise). The Guardrail port keeps the union for async detectors
      // we may add later; for the built-in injection detector, casting via
      // a runtime check is safe.
      const verdict = detector.guard({
        content,
        ...(contextHint !== undefined && { meta: { source: contextHint } }),
      });
      if (verdict instanceof Promise) {
        throw new Error('createWebContentGuardrail: built-in injection detector must be sync');
      }
      return verdict;
    },
  };
}
