/**
 * Langfuse PromptBackend — prompt management entry point for
 * `@harness-one/langfuse`.
 *
 * @module
 */

import type { Langfuse } from 'langfuse';
import type { PromptBackend, PromptTemplate } from 'harness-one/prompt';
import { safeWarn } from 'harness-one/observe';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

// ---------------------------------------------------------------------------
// PromptBackend
// ---------------------------------------------------------------------------

/** Configuration for the Langfuse prompt backend. */
export interface LangfusePromptBackendConfig {
  /** A pre-configured Langfuse client instance. */
  readonly client: Langfuse;
}

/**
 * Create a PromptBackend that fetches prompt templates from Langfuse
 * prompt management.
 *
 * Langfuse prompts use `{{variable}}` placeholders which map directly
 * to harness-one template variables.
 *
 * @example
 * ```ts
 * import { Langfuse } from 'langfuse';
 * import { createLangfusePromptBackend } from '@harness-one/langfuse';
 * import { createPromptBuilder } from 'harness-one/prompt';
 *
 * const client = new Langfuse({ ... });
 * const backend = createLangfusePromptBackend({ client });
 * const prompts = createPromptBuilder({ backend });
 * ```
 */
export function createLangfusePromptBackend(config: LangfusePromptBackendConfig): PromptBackend {
  const { client } = config;
  const knownPromptNames = new Set<string>();

  function toPromptTemplate(
    name: string,
    lfPrompt: { prompt: unknown; version: number },
  ): PromptTemplate {
    if (typeof lfPrompt.prompt !== 'string') {
      throw new HarnessError(`Langfuse prompt "${name}" is not a string type`, HarnessErrorCode.ADAPTER_ERROR, 'Ensure the Langfuse prompt is configured as a text type');
    }
    const content = lfPrompt.prompt;
    const variableMatches = content.match(/\{\{(\w+)\}\}/g) ?? [];
    const variables = [...new Set(variableMatches.map((m) => m.replace(/\{\{|\}\}/g, '')))];

    return {
      id: name,
      version: String(lfPrompt.version),
      content,
      variables,
      metadata: {
        source: 'langfuse',
        fetchedAt: Date.now(),
      },
    };
  }

  return {
    async fetch(id: string): Promise<PromptTemplate | undefined> {
      try {
        const lfPrompt = await client.getPrompt(id);
        knownPromptNames.add(id);
        return toPromptTemplate(id, lfPrompt as { prompt: unknown; version: number });
      } catch (err) {
        // Log warning instead of silently swallowing — network/auth failures should be visible
        safeWarn(undefined, `[harness-one/langfuse] Failed to fetch prompt "${id}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    },

    async list(): Promise<PromptTemplate[]> {
      const templates: PromptTemplate[] = [];
      for (const name of knownPromptNames) {
        try {
          const lfPrompt = await client.getPrompt(name);
          templates.push(toPromptTemplate(name, lfPrompt as { prompt: unknown; version: number }));
        } catch (err) {
          safeWarn(undefined, `[harness-one/langfuse] Failed to fetch prompt "${name}" during list`, {
            error: err instanceof Error ? err.message : String(err),
          });
          knownPromptNames.delete(name);
        }
      }
      return templates;
    },

    /**
     * @throws Always throws - Langfuse prompt management is read-only via this
     * adapter. Use the Langfuse dashboard to manage prompts.
     */
    async push(): Promise<void> {
      throw new HarnessError(
        'Langfuse SDK does not support pushing prompts programmatically',
        HarnessErrorCode.CORE_UNSUPPORTED_OPERATION,
        'Use the Langfuse UI or REST API to create prompts',
      );
    },
  };
}
