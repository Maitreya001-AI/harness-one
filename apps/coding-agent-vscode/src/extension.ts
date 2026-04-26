/**
 * VS Code extension entry point for `harness-one-coding`.
 *
 * Wires three commands:
 *   - `harness-coding.run`     — prompt the user, run a task, stream
 *                                 results into a dedicated OutputChannel.
 *   - `harness-coding.resume`  — pick a checkpoint and resume.
 *   - `harness-coding.list`    — list checkpoints in the OutputChannel.
 *
 * The extension imports the programmatic API from `harness-one-coding`,
 * not the CLI. This keeps the path simple (no spawned tsx) and reuses
 * the same factories the CLI uses.
 *
 * @module
 */

import * as vscode from 'vscode';

import {
  buildAgentForExtension,
  collectListReport,
  formatTaskResult,
} from './run-task.js';

const CHANNEL_NAME = 'Harness Coding';

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  }
  return channel;
}

/** Activate hook called by VS Code when one of our commands fires. */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('harness-coding.run', () => runTaskCommand(context)),
    vscode.commands.registerCommand('harness-coding.resume', () => resumeCommand(context)),
    vscode.commands.registerCommand('harness-coding.list', () => listCommand(context)),
  );
}

export function deactivate(): void {
  channel?.dispose();
  channel = undefined;
}

async function runTaskCommand(context: vscode.ExtensionContext): Promise<void> {
  const prompt = await vscode.window.showInputBox({
    title: 'Harness Coding: task description',
    prompt: 'What should the coding agent do?',
    ignoreFocusOut: true,
  });
  if (!prompt) return;

  const out = getChannel();
  out.show(true);
  out.appendLine(`[harness-coding] running task: ${prompt}`);
  try {
    const agent = await buildAgentForExtension({ context, env: process.env });
    const result = await agent.runTask({ prompt });
    out.appendLine(formatTaskResult(result));
    await agent.shutdown();
    if (result.reason === 'completed') {
      void vscode.window.showInformationMessage(
        `Harness Coding: ${result.state} (${result.changedFiles.length} files changed)`,
      );
    } else {
      void vscode.window.showWarningMessage(
        `Harness Coding finished with reason: ${result.reason}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.appendLine(`[harness-coding] error: ${message}`);
    void vscode.window.showErrorMessage(`Harness Coding error: ${message}`);
  }
}

async function resumeCommand(context: vscode.ExtensionContext): Promise<void> {
  const out = getChannel();
  out.show(true);
  try {
    const agent = await buildAgentForExtension({ context, env: process.env });
    const checkpoints = await agent.listCheckpoints(50);
    if (checkpoints.length === 0) {
      void vscode.window.showInformationMessage('Harness Coding: no checkpoints to resume.');
      await agent.shutdown();
      return;
    }
    const pick = await vscode.window.showQuickPick(
      checkpoints.map((c) => ({
        label: c.taskId,
        description: `${c.state} • iter=${c.iteration}`,
        detail: c.prompt,
      })),
      { title: 'Pick a checkpoint to resume' },
    );
    if (!pick) {
      await agent.shutdown();
      return;
    }
    out.appendLine(`[harness-coding] resuming ${pick.label}`);
    const result = await agent.runTask({ prompt: '', resumeTaskId: pick.label });
    out.appendLine(formatTaskResult(result));
    await agent.shutdown();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.appendLine(`[harness-coding] resume failed: ${message}`);
    void vscode.window.showErrorMessage(`Harness Coding error: ${message}`);
  }
}

async function listCommand(context: vscode.ExtensionContext): Promise<void> {
  const out = getChannel();
  out.show(true);
  try {
    const agent = await buildAgentForExtension({ context, env: process.env });
    out.appendLine(await collectListReport(agent));
    await agent.shutdown();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.appendLine(`[harness-coding] list failed: ${message}`);
  }
}
