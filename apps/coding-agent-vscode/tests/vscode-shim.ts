/**
 * In-memory shim for the `vscode` module used during unit tests.
 *
 * VS Code injects this module at runtime in production; in tests we
 * substitute a hand-rolled implementation that only covers the surface
 * the extension actually consumes.
 *
 * @module
 */

export interface MemoryConfigBag {
  readonly entries: Record<string, unknown>;
}

interface ConfigurationLike {
  get<T>(key: string): T | undefined;
}

interface WorkspaceShape {
  workspaceFolders: readonly { readonly uri: { readonly fsPath: string } }[] | undefined;
  getConfiguration: (section: string) => ConfigurationLike;
}

interface WindowShape {
  showInputBox: (opts?: { title?: string; prompt?: string; ignoreFocusOut?: boolean }) => Promise<string | undefined>;
  showInformationMessage: (msg: string) => Promise<unknown>;
  showWarningMessage: (msg: string) => Promise<unknown>;
  showErrorMessage: (msg: string) => Promise<unknown>;
  showQuickPick: <T extends { label: string }>(
    items: T[],
    opts?: { title?: string },
  ) => Promise<T | undefined>;
  createOutputChannel: (name: string) => OutputChannelLike;
}

export interface OutputChannelLike {
  appendLine(line: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
  readonly buffer: string[];
}

interface CommandsShape {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => Disposable;
  readonly registry: Map<string, (...args: unknown[]) => unknown>;
}

interface Disposable {
  dispose(): void;
}

interface ExtensionContextShape {
  subscriptions: Disposable[];
}

const config: { entries: Record<string, unknown> } = { entries: {} };

const channels = new Map<string, OutputChannelLike>();
let lastInputBox: string | undefined;
let lastQuickPickIndex = 0;
const messages: string[] = [];
const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();
let workspaceFsPath: string | undefined;

export const window: WindowShape = {
  async showInputBox() {
    return lastInputBox;
  },
  async showInformationMessage(msg) {
    messages.push(`info: ${msg}`);
    return undefined;
  },
  async showWarningMessage(msg) {
    messages.push(`warn: ${msg}`);
    return undefined;
  },
  async showErrorMessage(msg) {
    messages.push(`error: ${msg}`);
    return undefined;
  },
  async showQuickPick(items) {
    return items[lastQuickPickIndex];
  },
  createOutputChannel(name) {
    let buffer: string[] = [];
    const ch: OutputChannelLike = {
      appendLine: (line) => buffer.push(line),
      show: () => undefined,
      dispose: () => {
        buffer = [];
      },
      get buffer() {
        return buffer;
      },
    };
    channels.set(name, ch);
    return ch;
  },
};

export const workspace: WorkspaceShape = {
  get workspaceFolders() {
    return workspaceFsPath ? [{ uri: { fsPath: workspaceFsPath } }] : undefined;
  },
  getConfiguration(_section) {
    return {
      get<T>(key: string): T | undefined {
        return config.entries[key] as T | undefined;
      },
    };
  },
};

export const commands: CommandsShape = {
  registerCommand(id, handler) {
    commandRegistry.set(id, handler);
    return { dispose: () => commandRegistry.delete(id) };
  },
  get registry() {
    return commandRegistry;
  },
};

export type ExtensionContext = ExtensionContextShape;

// Test helpers — drive shim state from the test side.

export function __setConfig(entries: Record<string, unknown>): void {
  config.entries = entries;
}

export function __setInputBoxResponse(value: string | undefined): void {
  lastInputBox = value;
}

export function __setQuickPickIndex(index: number): void {
  lastQuickPickIndex = index;
}

export function __getChannel(name: string): OutputChannelLike | undefined {
  return channels.get(name);
}

export function __getMessages(): readonly string[] {
  return messages;
}

export function __reset(): void {
  config.entries = {};
  channels.clear();
  messages.length = 0;
  commandRegistry.clear();
  lastInputBox = undefined;
  lastQuickPickIndex = 0;
  workspaceFsPath = undefined;
}

export function __setWorkspace(fsPath: string | undefined): void {
  workspaceFsPath = fsPath;
}
