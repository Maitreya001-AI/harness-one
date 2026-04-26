/**
 * Soft-guardrail approval flow (DESIGN §3.6).
 *
 * The auditor sits between the AgentLoop and the tool layer for any tool
 * call whose policy says "ask first". MVP supports three modes:
 *
 *   - `auto`        — every approval is accepted (use only inside trusted
 *                     environments; CI defaults to this with a deny-all
 *                     command allowlist as the actual safety net).
 *   - `always-ask`  — prompt the user via stdin for every soft-guardrail
 *                     hit. Stdin is non-interactive in CI; always-ask
 *                     therefore falls through to deny when the stream is
 *                     not a TTY.
 *   - `allowlist`   — a static set of tool-name + arg-fingerprint pairs
 *                     auto-approve, everything else falls through to
 *                     `always-ask` semantics.
 *
 * @module
 */

import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
} from '../agent/types.js';
import { DEFAULT_COMMAND_ALLOWLIST, evaluateCommandPolicy } from './allowlist.js';

export interface AuditorOptions {
  readonly mode: ApprovalMode;
  /** Static allowlist of `<toolName>:<fingerprint>` pairs auto-approved. */
  readonly autoAllowFingerprints?: readonly string[];
  /** Static allowlist of shell command names auto-approved. */
  readonly autoAllowCommands?: readonly string[];
  /** Override stdin/stdout streams for tests. */
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /** When true, always-ask blocks instead of denying when stdin is not a TTY. */
  readonly nonInteractiveDeny?: boolean;
  /** Hard pre-flight filter applied before the user is ever prompted. */
  readonly commandDenyPatterns?: readonly RegExp[];
  readonly commandAllowlist?: readonly string[];
}

export interface Auditor {
  decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/** Build an auditor configured by `mode`. Pure-fn — no I/O until `decide()`. */
export function createAuditor(options: AuditorOptions): Auditor {
  const fingerprints = new Set(options.autoAllowFingerprints ?? []);
  const autoAllowCommands = new Set(options.autoAllowCommands ?? []);

  return {
    async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
      // Hard pre-flight: shell calls always run the static command policy
      // even before the user is prompted. Catches LLM-emitted dangerous
      // commands without burning a prompt round-trip.
      if (request.toolName === 'shell') {
        const command = stringField(request.arguments, 'command');
        const args = arrayField(request.arguments, 'args');
        if (command !== undefined) {
          // The pre-flight allowlist combines the explicit override (if any),
          // the auditor's auto-allow set, and the canonical default —
          // otherwise an `auto`/`always-ask` auditor with no explicit
          // commandAllowlist would reject every shell call before reaching
          // the user prompt.
          const allowlist =
            options.commandAllowlist ??
            [
              ...new Set([...autoAllowCommands, ...DEFAULT_COMMAND_ALLOWLIST]),
            ];
          const policy = evaluateCommandPolicy({
            command,
            args,
            allowlist,
            ...(options.commandDenyPatterns !== undefined && {
              denyPatterns: options.commandDenyPatterns,
            }),
          });
          if (!policy.allow) {
            return { allow: false, reason: policy.reason ?? 'denied by command policy' };
          }
        }
      }

      const fp = fingerprintRequest(request);

      switch (options.mode) {
        case 'auto':
          return { allow: true };

        case 'allowlist': {
          if (fingerprints.has(fp)) return { allow: true };
          if (
            request.toolName === 'shell' &&
            autoAllowCommands.has(stringField(request.arguments, 'command') ?? '')
          ) {
            return { allow: true };
          }
          return askInteractive(request, options);
        }

        case 'always-ask':
          return askInteractive(request, options);
      }
    },
  };
}

/** Stable per-request fingerprint used by allowlist matching. */
export function fingerprintRequest(request: ApprovalRequest): string {
  const args = JSON.stringify(canonicalize(request.arguments));
  return `${request.toolName}:${args}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

async function askInteractive(
  request: ApprovalRequest,
  options: AuditorOptions,
): Promise<ApprovalDecision> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  // Detect non-TTY environments (CI / piped stdin) and fail-closed unless
  // the caller explicitly opted into deny-when-piped behaviour.
  const isTty = (input as NodeJS.ReadStream).isTTY === true;
  if (!isTty) {
    return {
      allow: false,
      reason:
        'Approval required but stdin is not a TTY. Set --approval auto, ' +
        'add the call to the allowlist, or run from an interactive shell.',
    };
  }

  output.write(
    `\n[coding-agent] approval requested for ${request.toolName}: ${request.reason}\n` +
      `  args: ${JSON.stringify(request.arguments)}\n` +
      '  Allow? [y/N] ',
  );
  return new Promise<ApprovalDecision>((resolve) => {
    let buf = '';
    let settled = false;
    const settle = (decision: ApprovalDecision): void => {
      if (settled) return;
      settled = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      resolve(decision);
    };
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const newlineIdx = buf.indexOf('\n');
      if (newlineIdx === -1) return;
      const line = buf.slice(0, newlineIdx).trim().toLowerCase();
      if (line === 'y' || line === 'yes') settle({ allow: true });
      else settle({ allow: false, reason: 'denied by user via stdin' });
    };
    const onEnd = (): void => {
      // If buf has content without trailing newline, treat last line as input.
      if (buf.length > 0 && !settled) {
        const line = buf.trim().toLowerCase();
        if (line === 'y' || line === 'yes') {
          settle({ allow: true });
          return;
        }
      }
      settle({ allow: false, reason: 'stdin closed before answer' });
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);
  });
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function arrayField(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string');
  return [];
}
