/**
 * Hard-guardrail policy for the coding agent.
 *
 * These guardrails feed the LLM's `inputPipeline` / `outputPipeline` slots so
 * the AgentLoop can detect dangerous tool-call shapes *before* the tool
 * executes. They complement the per-tool allowlist enforcement (which is
 * itself a hard guardrail at the tool seam) by giving the harness a chance to
 * surface a `guardrail_blocked` event and abort the loop.
 *
 * @module
 */

import { createPipeline } from 'harness-one/guardrails';
import type {
  Guardrail,
  GuardrailPipeline,
  GuardrailVerdict,
} from 'harness-one/guardrails';

import { DEFAULT_COMMAND_DENY_PATTERNS } from './allowlist.js';

/**
 * Build a guardrail that scans free-form text for dangerous shell pattern
 * fragments. This catches LLM rationale (e.g. "I'll run `rm -rf /`") in
 * addition to the per-tool allowlist that already blocks unsafe argv shapes.
 */
export function createDangerousCommandTextGuardrail(
  patterns: readonly RegExp[] = DEFAULT_COMMAND_DENY_PATTERNS,
): Guardrail {
  return (ctx): GuardrailVerdict => {
    for (const pattern of patterns) {
      if (pattern.test(ctx.content)) {
        return {
          action: 'block',
          reason: `Content matches dangerous command pattern ${pattern}`,
        };
      }
    }
    return { action: 'allow' };
  };
}

/**
 * Build a guardrail that scrubs absolute paths to known-secret files
 * (e.g. `~/.ssh/id_rsa`) by rewriting them. We rewrite rather than block so
 * a benign mention in the LLM's text doesn't tank the entire turn — the
 * tool layer is the authoritative blocker for actual file access.
 */
export function createSecretPathScrubGuardrail(): Guardrail {
  const secretRegex = /(\.env(\.[a-z0-9_-]+)?|id_rsa|id_dsa|id_ed25519|\b[a-z0-9_-]+\.(pem|key|pfx|p12)\b)/gi;
  return (ctx): GuardrailVerdict => {
    if (!secretRegex.test(ctx.content)) return { action: 'allow' };
    secretRegex.lastIndex = 0;
    const modified = ctx.content.replace(secretRegex, '<redacted-secret-path>');
    return { action: 'modify', modified, reason: 'Redacted possible secret-bearing path' };
  };
}

/**
 * Build the canonical input + output guardrail pipeline used by the coding
 * agent. The harness wraps the AgentLoop with `inputPipeline` for user
 * messages and `outputPipeline` for tool / final-answer scrubbing.
 */
export function createCodingGuardrails(options?: {
  readonly extraInputGuards?: readonly { readonly name: string; readonly guard: Guardrail }[];
  readonly extraOutputGuards?: readonly { readonly name: string; readonly guard: Guardrail }[];
}): {
  readonly input: GuardrailPipeline;
  readonly output: GuardrailPipeline;
} {
  const inputGuards = [
    { name: 'dangerous-command-text', guard: createDangerousCommandTextGuardrail() },
    ...(options?.extraInputGuards ?? []),
  ];
  const outputGuards = [
    { name: 'secret-path-scrub', guard: createSecretPathScrubGuardrail() },
    ...(options?.extraOutputGuards ?? []),
  ];

  const input = createPipeline({ input: inputGuards });
  const output = createPipeline({ output: outputGuards });
  return { input, output };
}
