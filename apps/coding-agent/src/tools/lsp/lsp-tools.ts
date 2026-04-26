/**
 * High-level LSP tools — `lsp_definition` + `lsp_references`.
 *
 * Both tools share a single `LspClient` instance held in a small
 * lifecycle object so the LSP server boots once per agent and is torn
 * down at `dispose()`. The `LspToolset` object exposes both tool
 * definitions plus a dispose hook.
 *
 * Capability: `filesystem` (read-only over LSP-spawned subprocess).
 *
 * @module
 */

import {
  ToolCapability,
  defineTool,
  toolError,
  toolSuccess,
} from 'harness-one/tools';
import type { ToolDefinition } from 'harness-one/tools';

import { createLspClient, type LspClient, type LspClientOptions } from './client.js';

export interface LspToolsetOptions extends LspClientOptions {
  /** Lazily start the LSP client on first invocation. Default: true. */
  readonly lazy?: boolean;
}

export interface LspToolset {
  readonly client: LspClient;
  readonly tools: readonly ToolDefinition<unknown>[];
  dispose(): Promise<void>;
}

interface LspPositionInput {
  readonly path: string;
  readonly line: number;
  readonly character: number;
}

interface LspLocation {
  readonly uri: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

export function createLspToolset(options: LspToolsetOptions): LspToolset {
  const client = createLspClient(options);
  let started = false;

  async function ensureStarted(): Promise<void> {
    if (started) return;
    await client.initialize();
    started = true;
  }

  const definitionTool = defineTool<LspPositionInput>({
    name: 'lsp_definition',
    description:
      'Look up the definition of a symbol via the language server. Returns ' +
      'a list of locations (uri + range).',
    capabilities: [ToolCapability.Filesystem, ToolCapability.Readonly],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.', minLength: 1 },
        line: { type: 'integer', minimum: 0 },
        character: { type: 'integer', minimum: 0 },
      },
      required: ['path', 'line', 'character'],
      additionalProperties: false,
    },
    async execute(params) {
      try {
        await ensureStarted();
        const result = (await client.request('textDocument/definition', {
          textDocument: { uri: client.uri(params.path) },
          position: { line: params.line, character: params.character },
        })) as LspLocation | LspLocation[] | null;
        const locations = normalizeLocations(result);
        return toolSuccess({ locations });
      } catch (err) {
        return toolError(
          `lsp_definition failed: ${err instanceof Error ? err.message : String(err)}`,
          'internal',
          'Verify the language server is healthy and the position is valid',
          true,
        );
      }
    },
  });

  const referencesTool = defineTool<LspPositionInput & { includeDeclaration?: boolean }>({
    name: 'lsp_references',
    description:
      'List references to the symbol at the given position via the language ' +
      'server. Returns up to 200 locations.',
    capabilities: [ToolCapability.Filesystem, ToolCapability.Readonly],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        line: { type: 'integer', minimum: 0 },
        character: { type: 'integer', minimum: 0 },
        includeDeclaration: { type: 'boolean' },
      },
      required: ['path', 'line', 'character'],
      additionalProperties: false,
    },
    async execute(params) {
      try {
        await ensureStarted();
        const result = (await client.request('textDocument/references', {
          textDocument: { uri: client.uri(params.path) },
          position: { line: params.line, character: params.character },
          context: { includeDeclaration: params.includeDeclaration ?? true },
        })) as LspLocation[] | null;
        const locations = (result ?? []).slice(0, 200);
        return toolSuccess({ locations });
      } catch (err) {
        return toolError(
          `lsp_references failed: ${err instanceof Error ? err.message : String(err)}`,
          'internal',
          'Verify the language server is healthy and the position is valid',
          true,
        );
      }
    },
  });

  return {
    client,
    tools: [
      definitionTool as ToolDefinition<unknown>,
      referencesTool as ToolDefinition<unknown>,
    ],
    async dispose(): Promise<void> {
      if (!started) return;
      await client.shutdown();
      started = false;
    },
  };
}

function normalizeLocations(value: LspLocation | LspLocation[] | null): LspLocation[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [value];
}
