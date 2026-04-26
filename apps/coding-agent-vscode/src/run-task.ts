/**
 * Programmatic glue between VS Code commands and the `harness-one-coding`
 * factory. Kept separate from `extension.ts` so the formatting + agent-
 * construction logic is unit-testable without booting the VS Code host.
 *
 * @module
 */

import * as vscode from 'vscode';
import type { CodingAgent, TaskResult } from 'harness-one-coding';
import { createCodingAgent } from 'harness-one-coding';
import type { AgentAdapter } from 'harness-one/core';

export interface BuildAgentOptions {
  readonly context: vscode.ExtensionContext;
  readonly env: NodeJS.ProcessEnv;
  /** Test seam — bypass the real Anthropic SDK. */
  readonly adapterFactory?: (model: string, apiKey: string | undefined) => Promise<AgentAdapter>;
  /** Test seam — override the checkpoint directory (otherwise default `~/.harness-coding/checkpoints`). */
  readonly checkpointDir?: string;
}

export async function buildAgentForExtension(
  options: BuildAgentOptions,
): Promise<CodingAgent> {
  const config = vscode.workspace.getConfiguration('harnessCoding');
  const model = config.get<string>('model') ?? 'claude-sonnet-4-20250514';
  const maxTokens = config.get<number>('maxTokens') ?? 200_000;
  const maxIterations = config.get<number>('maxIterations') ?? 100;
  const maxDurationMin = config.get<number>('maxDurationMinutes') ?? 30;
  const approval = (config.get<string>('approval') ?? 'always-ask') as
    | 'auto'
    | 'always-ask'
    | 'allowlist';
  const dryRun = config.get<boolean>('dryRun') ?? false;

  const apiKey = options.env['ANTHROPIC_API_KEY'];
  const factory = options.adapterFactory ?? defaultAdapterFactory;
  const adapter = await factory(model, apiKey);

  const folders = vscode.workspace.workspaceFolders;
  const workspace = folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();

  return createCodingAgent({
    adapter,
    workspace,
    model,
    approval,
    dryRun,
    ...(options.checkpointDir !== undefined && { checkpointDir: options.checkpointDir }),
    budget: {
      tokens: maxTokens,
      iterations: maxIterations,
      durationMs: maxDurationMin * 60_000,
    },
  });
}

async function defaultAdapterFactory(
  model: string,
  apiKey: string | undefined,
): Promise<AgentAdapter> {
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to your shell environment before invoking the extension.',
    );
  }
  const [{ default: Anthropic }, { createAnthropicAdapter }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('@harness-one/anthropic'),
  ]);
  const client = new Anthropic({ apiKey });
  return createAnthropicAdapter({ client, model });
}

export function formatTaskResult(result: TaskResult): string {
  const lines: string[] = [
    '',
    `Task ${result.taskId} → ${result.state} (${result.reason})`,
    `Iterations: ${result.iterations}    Duration: ${result.durationMs}ms    Cost: $${result.cost.usd.toFixed(4)} (${result.cost.tokens} tokens)`,
  ];
  if (result.changedFiles.length > 0) {
    lines.push(`Changed files (${result.changedFiles.length}):`);
    for (const path of result.changedFiles) lines.push(`  - ${path}`);
  }
  if (result.errorMessage) lines.push(`Error: ${result.errorMessage}`);
  if (result.summary) {
    lines.push('Summary:');
    for (const ln of result.summary.split('\n')) lines.push(`  ${ln}`);
  }
  return lines.join('\n');
}

export async function collectListReport(agent: CodingAgent): Promise<string> {
  const summaries = await agent.listCheckpoints(50);
  if (summaries.length === 0) return 'No checkpoints found.';
  const rows = summaries.map(
    (s) =>
      `${s.taskId}\t${s.state}\titer=${s.iteration}\t${new Date(s.lastUpdatedAt).toISOString()}\t${truncate(s.prompt, 60)}`,
  );
  return ['taskId\tstate\titeration\tlastUpdated\tprompt', ...rows].join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
