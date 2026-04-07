// Install: npm install langfuse
//
// This example shows how to implement harness-one's PromptBackend interface
// for Langfuse's prompt management. The backend is then wired into
// createAsyncPromptRegistry, which caches locally and fetches on-demand.

import { Langfuse } from 'langfuse';
import type { PromptBackend, PromptTemplate } from 'harness-one/prompt';
import { createAsyncPromptRegistry } from 'harness-one/prompt';

// ---------------------------------------------------------------------------
// PromptBackend implementation for Langfuse
// ---------------------------------------------------------------------------

/**
 * Create a PromptBackend that fetches prompt templates from Langfuse.
 *
 * harness-one's PromptBackend interface requires:
 *   - fetch(id, version?): get a single template
 *   - list?(): list all templates (optional)
 *   - push?(template): push a template to remote (optional)
 *
 * Usage:
 *   const backend = createLangfuseBackend({ publicKey: '...', secretKey: '...' });
 *   const registry = createAsyncPromptRegistry(backend);
 *   const resolved = await registry.resolve('greeting', { name: 'Alice' });
 */
export function createLangfuseBackend(config: {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}): PromptBackend {
  const langfuse = new Langfuse({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl ?? 'https://cloud.langfuse.com',
  });

  /**
   * Parse a Langfuse prompt into harness-one's PromptTemplate format.
   *
   * Langfuse prompts contain {{variable}} placeholders, which map directly
   * to harness-one's template variable syntax.
   */
  function toPromptTemplate(
    name: string,
    lfPrompt: { prompt: unknown; version: number },
  ): PromptTemplate {
    const content = String(lfPrompt.prompt);

    // Extract {{variable}} names from the template
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
    // -----------------------------------------------------------------
    // fetch: retrieve a single prompt from Langfuse
    // -----------------------------------------------------------------
    async fetch(id: string, _version?: string): Promise<PromptTemplate | undefined> {
      try {
        // Langfuse getPrompt returns the latest production version by default.
        // Version pinning can be added via Langfuse's label system.
        const lfPrompt = await langfuse.getPrompt(id);
        return toPromptTemplate(id, lfPrompt as { prompt: unknown; version: number });
      } catch {
        // Prompt not found in Langfuse
        return undefined;
      }
    },

    // -----------------------------------------------------------------
    // list: return all available prompts (optional method)
    // -----------------------------------------------------------------
    async list(): Promise<PromptTemplate[]> {
      // Langfuse SDK does not have a native "list all prompts" method,
      // so you would either:
      //   1. Use the Langfuse REST API directly, or
      //   2. Maintain a known list of prompt names and fetch each
      //
      // This example demonstrates option 2 with a hardcoded list.
      // In production, replace this with your prompt name registry.
      console.warn('Langfuse backend list() requires known prompt names.');
      return [];
    },

    // -----------------------------------------------------------------
    // push: upload a template to Langfuse (optional method)
    // -----------------------------------------------------------------
    async push(template: PromptTemplate): Promise<void> {
      // Langfuse prompt creation is typically done via the Langfuse UI
      // or REST API. This is a placeholder showing the pattern.
      //
      // POST https://cloud.langfuse.com/api/public/v2/prompts
      // { name: template.id, prompt: template.content, type: "text" }
      console.log(`Would push template "${template.id}" to Langfuse (not implemented in SDK)`);
    },
  };
}

// ---------------------------------------------------------------------------
// Example: wire into createAsyncPromptRegistry
// ---------------------------------------------------------------------------

async function demo() {
  // 1. Create the backend (implements PromptBackend)
  const backend = createLangfuseBackend({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
  });

  // 2. Inject backend into harness-one's async registry
  //    The registry caches templates locally after the first fetch.
  const registry = createAsyncPromptRegistry(backend);

  // 3. Pre-fetch known prompts for faster access
  await registry.prefetch(['greeting', 'system-prompt', 'summarizer']);

  // 4. Resolve a prompt (fetches from Langfuse if not cached)
  try {
    const result = await registry.resolve('greeting', { name: 'Alice' });
    console.log('Resolved:', result);
  } catch (err) {
    console.log('Prompt not found (expected in demo):', (err as Error).message);
  }

  // 5. Local overrides take priority over Langfuse
  registry.register({
    id: 'greeting',
    version: 'local-1',
    content: 'Hey {{name}}, welcome back!',
    variables: ['name'],
  });

  // This now uses the local override, not Langfuse
  const local = await registry.resolve('greeting', { name: 'Bob' });
  console.log('Local override:', local);

  // 6. List all templates (local + remote)
  const all = await registry.list();
  console.log(`Total templates: ${all.length}`);
}

demo().catch(console.error);
